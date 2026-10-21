import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Page = { quote: { number: string; status: string }; fingerprint: string; replaced: { number: string } | null };
type Answer = { status: string; decision?: string };

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * QUO-09 (owner, 18 October 2026, answer 18): the customer accepts and signs, or declines, on the quote's page, through
 * public.quote_public_decide (service_role only). Once, on the version the page shows, with the full IP and browser kept
 * with the quote for owners and admins only, emptied by a privacy erasure.
 */
describe("the customer's decision on a quote (QUO-09)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const sentQuote = (opts: { contact?: boolean } = {}) =>
    asUser(member.id, async (q) => {
      const contact = opts.contact
        ? (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'רונית', $2) returning id", [org, member.id])).id
        : null;
      const deal = contact
        ? null
        : (
            await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
              org,
              pipelineId,
              stageId,
              member.id,
            ])
          ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'שיפוץ', $2, $3) returning id", [org, deal, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 50000)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      return { quote, contact };
    });
  const linkOf = (quote: string) => asUser(member.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
  type Version = { number: string | null; fingerprint: string | null };
  const version = (token: string) => asService(async (q) => (await one<{ v: Version }>(q, "select public.quote_public_version($1) as v", [token])).v);
  // what the customer's page reads: quote_public, then the fingerprint of the same version (public-server.ts)
  const page = async (token: string): Promise<Page> => {
    const shown = await asService(async (q) => (await one<{ p: Omit<Page, "fingerprint"> }>(q, "select public.quote_public($1) as p", [token])).p);
    const v = await version(token);
    expect(v.number).toBe(shown.quote.number);
    return { ...shown, fingerprint: v.fingerprint as string };
  };
  const decide = (token: string, args: Record<string, unknown>) =>
    asService(async (q) =>
      (
        await one<{ a: Answer }>(
          q,
          `select public.quote_public_decide(p_token => $1, p_decision => $2, p_fingerprint => $3, p_signer_name => $4, p_id_number => $5,
                    p_signature_kind => $6, p_signature_image => $7, p_wording_version => $8, p_agreed => $9, p_decline_reason => $10,
                    p_ip => $11, p_user_agent => $12) as a`,
          [
            token,
            args.decision ?? "accepted",
            args.fingerprint,
            "name" in args ? args.name : "רונית לוי",
            args.id ?? null,
            args.kind ?? "drawn",
            "image" in args ? args.image : PNG,
            args.wording ?? "draft-2026-10-18",
            args.agreed ?? true,
            args.reason ?? null,
            args.ip ?? "2001:db8::1234",
            args.ua ?? "Mozilla/5.0 (iPhone)",
          ],
        )
      ).a,
    );
  const status = (quote: string) => asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.quotes where id = $1", [quote])).s);
  const decisions = (quote: string) => asAdmin((q) => count(q, "select 1 from public.quote_decisions where quote_id = $1", [quote]));

  beforeAll(async () => {
    owner = await createUser("qd-owner");
    org = await createOrg(owner.id, "עסק החתימות");
    admin = await addMember(org, owner.id, "admin", "qd-admin");
    manager = await addMember(org, owner.id, "manager", "qd-manager");
    member = await addMember(org, owner.id, "member", "qd-member");
    viewer = await addMember(org, owner.id, "viewer", "qd-viewer");
    outsider = await createUser("qd-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("accepting with a drawn signature decides once, keeps the evidence and locks the quote", async () => {
    const { quote } = await sentQuote();
    const token = await linkOf(quote);
    const shown = await page(token);
    expect(shown.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const answer = await decide(token, { fingerprint: shown.fingerprint, id: "000000018" });
    // only the outcome comes back
    expect(answer).toEqual({ status: "accepted" });
    expect(await status(quote)).toBe("accepted");
    const row = await asAdmin(async (q) =>
      one<Record<string, unknown>>(
        q,
        "select decision, signer_name, signer_id_number, signature_kind, signature_image, wording_version, content_sha256, ip, user_agent from public.quote_decisions where quote_id = $1",
        [quote],
      ),
    );
    expect(row).toEqual({
      decision: "accepted",
      signer_name: "רונית לוי",
      signer_id_number: "000000018",
      signature_kind: "drawn",
      signature_image: PNG,
      wording_version: "draft-2026-10-18",
      content_sha256: shown.fingerprint,
      ip: "2001:db8::1234",
      user_agent: "Mozilla/5.0 (iPhone)",
    });
    // QUO-16's trigger wrote the timeline entry as a system entry
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where metadata->>'quote_id' = $1 and metadata->>'kind' = 'quote_accepted' and type = 'system'", [quote]))).toBe(1);
    // once: a second try is answered, nothing changes
    expect(await decide(token, { decision: "rejected", fingerprint: shown.fingerprint })).toEqual({ status: "already_decided", decision: "accepted" });
    expect(await decisions(quote)).toBe(1);
    // the page shows the outcome, and the quote is locked (QUO-12 refuses a version)
    expect((await page(token)).quote.status).toBe("accepted");
    expect((await pgError(asUser(member.id, (q) => q("select public.quote_new_version($1, $2)", [org, quote])))).hint).toBe("quote_version:closed");
  });

  it("the version reader answers only the number and fingerprint, counts no view, and is for the server only", async () => {
    const { quote } = await sentQuote();
    const token = await linkOf(quote);
    await page(token);
    const views = () => asAdmin(async (q) => (await one<{ c: number }>(q, "select window_count as c from app.quote_links where quote_id = $1", [quote])).c);
    const before = await views();
    const v = await version(token);
    expect(Object.keys(v).sort()).toEqual(["fingerprint", "number"]);
    expect(JSON.stringify(v)).not.toContain(quote);
    expect(await views()).toBe(before);
    // over the link's view limit it answers only that
    await asAdmin((q) => q("update app.quote_links set window_started_at = now(), window_count = 121 where quote_id = $1", [quote]));
    expect(await version(token)).toEqual({ rate_limited: true });
    await asAdmin((q) => q("update app.quote_links set window_count = 0 where quote_id = $1", [quote]));
    expect((await pgError(version("x".repeat(64)))).code).toBe("P0002");
    for (const [role, expected] of [
      ["anon", false],
      ["authenticated", false],
      ["service_role", true],
    ] as const) {
      expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, 'public.quote_public_version(text)', 'execute') as c", [role])).c), role).toBe(
        expected,
      );
    }
    // a quote the customer has viewed (QUO-10) is still open; after the answer there is nothing to sign
    await asAdmin((q) => q("update public.quotes set status = 'viewed' where id = $1", [quote]));
    const viewed = await version(token);
    expect(viewed.fingerprint).toBe(v.fingerprint);
    expect(await decide(token, { decision: "rejected", fingerprint: viewed.fingerprint, name: null })).toEqual({ status: "rejected" });
    expect(await version(token)).toEqual({ number: v.number, fingerprint: null });
  });

  it("the quote's owner is told, with the number and title and no amounts", async () => {
    const { quote } = await sentQuote();
    const token = await linkOf(quote);
    await decide(token, { fingerprint: (await page(token)).fingerprint });
    const notes = await asAdmin(async (q) =>
      (await q<{ user_id: string; type: string; title: string; body: string | null; entity_type: string }>(
        // QUO-10: opening the page also sent a quote_viewed notice (test 175); this one is about the decision
        "select user_id, type, title, body, entity_type from public.notifications where entity_id = $1 and type <> 'quote_viewed'",
        [quote],
      )).rows,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ user_id: member.id, type: "quote", title: "הצעת מחיר אושרה: שיפוץ", entity_type: "quote" });
    expect(notes[0].body).toMatch(/^הצעה /);
    // the text, not the random ids (a uuid may hold "500")
    expect(`${notes[0].title} ${notes[0].body ?? ""}`).not.toMatch(/500|590/);
  });

  it("a typed signature, a refusal with a reason, and invalid answers that change nothing", async () => {
    const a = await sentQuote();
    const ta = await linkOf(a.quote);
    const fa = (await page(ta)).fingerprint;
    for (const bad of [
      { agreed: false },
      { name: "א" },
      { id: "123456789" },
      { kind: "drawn", image: "data:image/jpeg;base64,AAAA" },
      { kind: "scribble" },
      { wording: "" },
      { decision: "maybe" },
    ]) {
      expect(await decide(ta, { fingerprint: fa, ...bad }), JSON.stringify(bad)).toEqual({ status: "invalid" });
    }
    // QUO-10: opening the page marked the quote viewed; the invalid answers changed nothing else
    expect([await status(a.quote), await decisions(a.quote)]).toEqual(["viewed", 0]);
    expect(await decide(ta, { fingerprint: fa, kind: "typed", image: null })).toEqual({ status: "accepted" });

    const b = await sentQuote();
    const tb = await linkOf(b.quote);
    expect(await decide(tb, { decision: "rejected", fingerprint: (await page(tb)).fingerprint, name: null, reason: "  יקר מדי  " })).toEqual({ status: "rejected" });
    expect(await status(b.quote)).toBe("rejected");
    expect(await asAdmin(async (q) => one(q, "select decline_reason, signature_kind, signer_name from public.quote_decisions where quote_id = $1", [b.quote]))).toEqual({
      decline_reason: "יקר מדי",
      signature_kind: null,
      signer_name: null,
    });
  });

  it("decides only on the version the page shows: a changed version is refused, a newer one on an old link is the one decided", async () => {
    const v1 = await sentQuote();
    const t1 = await linkOf(v1.quote);
    const f1 = (await page(t1)).fingerprint;
    const v2 = await asUser(member.id, async (q) => (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, v1.quote])).v);
    await asUser(member.id, (q) => q("update public.quote_lines set unit_price_agorot = 45000 where quote_id = $1", [v2]));
    await asUser(member.id, (q) => q("select public.quote_send($1, $2)", [org, v2]));
    await linkOf(v2);
    // the page on the old link now shows version 2; a decision made on what was seen before is refused
    const shown = await page(t1);
    expect(shown.replaced).not.toBeNull();
    expect(shown.fingerprint).not.toBe(f1);
    expect(await decide(t1, { fingerprint: f1 })).toEqual({ status: "changed" });
    // QUO-10: each was viewed when the old link showed it (version 1 first, then version 2)
    expect([await status(v1.quote), await status(v2), await decisions(v1.quote), await decisions(v2)]).toEqual(["viewed", "viewed", 0, 0]);
    // with what the page shows now, version 2 is accepted and the original stays as it was
    expect(await decide(t1, { fingerprint: shown.fingerprint })).toEqual({ status: "accepted" });
    expect([await status(v1.quote), await status(v2)]).toEqual(["viewed", "accepted"]);
  });

  it("tries are limited per link, and the limit holds because every outcome is an answer", async () => {
    const { quote } = await sentQuote();
    const token = await linkOf(quote);
    const fingerprint = (await page(token)).fingerprint;
    for (let i = 0; i < 10; i += 1) expect(await decide(token, { fingerprint, agreed: false })).toEqual({ status: "invalid" });
    expect(await decide(token, { fingerprint })).toEqual({ status: "rate_limited" });
    // QUO-10: viewed by opening the page, never decided
    expect(await status(quote)).toBe("viewed");
  });

  it("a wrong or revoked link finds nothing, a cancelled quote is not decided, and only the server may call it", async () => {
    expect((await pgError(decide("x".repeat(64), { fingerprint: "0".repeat(64) }))).code).toBe("P0002");
    expect((await pgError(decide("short", { fingerprint: "0".repeat(64) }))).code).toBe("P0002");
    const { quote } = await sentQuote();
    const token = await linkOf(quote);
    const fingerprint = (await page(token)).fingerprint;
    await asUser(member.id, (q) => q("select public.quote_link_revoke($1, $2)", [org, quote]));
    expect((await pgError(decide(token, { fingerprint }))).code).toBe("P0002");
    const cancelled = await sentQuote();
    const tc = await linkOf(cancelled.quote);
    const fc = (await page(tc)).fingerprint;
    await asAdmin((q) => q("update public.quotes set status = 'cancelled' where id = $1", [cancelled.quote]));
    // owner, 19 October 2026: the link still leads to the quote, which shows its status; it is never decided
    expect(await decide(tc, { fingerprint: fc })).toEqual({ status: "closed" });
    expect(await version(tc)).toEqual({ number: expect.any(String), fingerprint: null });
    expect(await status(cancelled.quote)).toBe("cancelled");
    for (const [role, expected] of [
      ["anon", false],
      ["authenticated", false],
      ["service_role", true],
    ] as const) {
      expect(
        await asAdmin(async (q) =>
          (await one<{ c: boolean }>(q, "select has_function_privilege($1, 'public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text)', 'execute') as c", [role])).c,
        ),
        role,
      ).toBe(expected);
    }
    for (const fn of ["app.quote_shown_version(public.quotes)", "app.quote_fingerprint(public.quotes)"]) {
      expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege('service_role', $1, 'execute') as c", [fn])).c), fn).toBe(false);
    }
  });

  it("the decision is read by owners and admins only, and by no other business", async () => {
    const { quote } = await sentQuote();
    const token = await linkOf(quote);
    await decide(token, { fingerprint: (await page(token)).fingerprint });
    for (const [u, expected] of [
      [owner, 1],
      [admin, 1],
      [manager, 0],
      [member, 0],
      [viewer, 0],
      [outsider, 0],
    ] as const) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.quote_decisions where quote_id = $1", [quote])), u.email).toBe(expected);
    }
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.quote_decisions where organization_id = $1", [org]))).toBe(0);
    // nobody writes it through the API
    expect((await pgError(asUser(owner.id, (q) => q("update public.quote_decisions set ip = null where quote_id = $1", [quote])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.quote_decisions where quote_id = $1", [quote])))).code).toBe("42501");
    void otherOrg;
  });

  it("a privacy erasure empties the signer's details and keeps what was decided and on which version", async () => {
    const { quote, contact } = await sentQuote({ contact: true });
    const token = await linkOf(quote);
    const fingerprint = (await page(token)).fingerprint;
    await decide(token, { fingerprint, id: "000000018" });
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    await asUser(owner.id, (q) => q("delete from public.contacts where id = $1", [contact]));
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    const row = await asAdmin(async (q) =>
      one<Record<string, unknown>>(
        q,
        "select decision, signer_name, signer_id_number, signature_image, ip, user_agent, decline_reason, content_sha256, erased_at is not null as erased from public.quote_decisions where quote_id = $1",
        [quote],
      ),
    );
    expect(row).toEqual({
      decision: "accepted",
      signer_name: null,
      signer_id_number: null,
      signature_image: null,
      ip: null,
      user_agent: null,
      decline_reason: null,
      content_sha256: fingerprint,
      erased: true,
    });
  });
});
