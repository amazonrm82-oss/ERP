import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * QUO-11, owner's answer of 19 October 2026 (ב): an accepted quote may be cancelled by owners and admins only, with a
 * reason; the audit log and the timeline record it, the customer's link says "cancelled" (no prices, no signing), and
 * the quote's people hear of it. The deal is not touched.
 */
describe("cancelling an accepted quote (QUO-11)", () => {
  let owner: U, admin: U, manager: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, openStage: string, wonStage: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const accepted = async () => {
    const ids = await asUser(member.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נועה', $2) returning id", [org, member.id])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'שיפוץ', $2, $3, $4, $5) returning id", [
          org,
          pipelineId,
          openStage,
          contact,
          member.id,
        ])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'שיפוץ מטבח', $2, $3) returning id", [org, deal, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 50000)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      const token = (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t;
      return { quote, deal, contact, token };
    });
    await asService(async (q) => {
      const fp = (await one<{ v: { fingerprint: string } }>(q, "select public.quote_public_version($1) as v", [ids.token])).v.fingerprint;
      await q(
        `select public.quote_public_decide(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'נועה כהן',
                  p_signature_kind => 'typed', p_wording_version => 'draft-2026-10-18', p_agreed => true)`,
        [ids.token, fp],
      );
    });
    return ids;
  };
  const cancel = (u: U, quote: string, reason: string | null, orgId = org) =>
    asUser(u.id, (q) => q("select public.quote_cancel_accepted($1, $2, $3)", [orgId, quote, reason]));
  const page = (token: string) => asService(async (q) => (await one<{ p: Record<string, unknown> }>(q, "select public.quote_public($1) as p", [token])).p);
  const row = (quote: string) =>
    asAdmin((q) =>
      one<{ status: string; cancelled_from: string | null; cancel_reason: string | null }>(q, "select status, cancelled_from, cancel_reason from public.quotes where id = $1", [quote]),
    );

  beforeAll(async () => {
    owner = await createUser("qca-owner");
    org = await createOrg(owner.id, "עסק הביטולים");
    admin = await addMember(org, owner.id, "admin", "qca-admin");
    manager = await addMember(org, owner.id, "manager", "qca-manager");
    member = await addMember(org, owner.id, "member", "qca-member");
    outsider = await createUser("qca-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    openStage = pipe.stages.find((s) => s.kind === "open")!.id;
    wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status, quote_accept_deal) values ($1, 'licensed', 'none') on conflict (organization_id) do update set vat_status = 'licensed', quote_accept_deal = 'none'", [org]),
    );
  });

  it("owners and admins only, with a reason; the quote's own cancel still refuses an accepted quote", async () => {
    const a = await accepted();
    for (const who of [member, manager]) expect((await pgError(cancel(who, a.quote, "הלקוח חזר בו"))).code, who.email).toBe("42501");
    expect((await pgError(cancel(outsider, a.quote, "הלקוח חזר בו"))).code).toBe("42501");
    expect((await pgError(cancel(outsider, a.quote, "הלקוח חזר בו", otherOrg))).code).toBe("42501");
    expect((await pgError(asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, a.quote]))))).toMatchObject({ hint: "quote_cancel:accepted" });
    for (const reason of [null, "", "   ", "א".repeat(501)]) expect((await pgError(cancel(admin, a.quote, reason))).hint).toBe("quote_cancel:reason");
    expect((await row(a.quote)).status).toBe("accepted");

    await cancel(admin, a.quote, "  הלקוח חזר בו  ");
    expect(await row(a.quote)).toEqual({ status: "cancelled", cancelled_from: "accepted", cancel_reason: "הלקוח חזר בו" });
    // once
    expect((await pgError(cancel(owner, a.quote, "שוב"))).hint).toBe("quote_cancel:not_accepted");
    // a sent quote is not cancelled here
    const sent = await asUser(member.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'עוד', $2) returning id", [org, a.deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 100)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    expect((await pgError(cancel(admin, sent, "סיבה"))).hint).toBe("quote_cancel:not_accepted");
  });

  it("the audit log and the timeline record it; the quote's people hear of it; the deal is not touched", async () => {
    const a = await accepted();
    await asAdmin((q) => q("update public.deals set stage_id = $2 where id = $1", [a.deal, wonStage]));
    await cancel(admin, a.quote, "טעות בתמחור");
    const audit = await asAdmin((q) =>
      one<{ actor_id: string; changes: Record<string, { new: unknown }> }>(
        q,
        "select actor_id, changes from public.audit_log where entity_type = 'quotes' and entity_id = $1 and action = 'update' order by id desc limit 1",
        [a.quote],
      ),
    );
    expect(audit.actor_id).toBe(admin.id);
    expect(audit.changes.status.new).toBe("cancelled");
    expect(audit.changes.cancel_reason.new).toBe("טעות בתמחור");
    const entry = await asAdmin((q) =>
      one<{ body: string; type: string; created_by: string | null }>(
        q,
        "select body, type, created_by from public.activities where deal_id = $1 and metadata->>'kind' = 'quote_cancelled'",
        [a.deal],
      ),
    );
    expect(entry.type).toBe("system");
    expect(entry.body).toMatch(/^הצעת מחיר .+ בוטלה על ידי .+ · סיבה: טעות בתמחור$/);
    const notices = await asAdmin(async (q) =>
      (await q<{ user_id: string; title: string; body: string }>("select user_id, title, body from public.notifications where entity_id = $1 and title like 'הצעת מחיר שאושרה בוטלה%'", [a.quote])).rows,
    );
    expect(notices.map((n) => n.user_id)).toEqual([member.id]);
    expect(notices[0].body).toMatch(/^הצעה .+ · סיבה: טעות בתמחור$/);
    // the deal stays as it was
    expect(await asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.deals where id = $1", [a.deal])).s)).toBe("won");
    // the actor is not told of their own cancel
    const b = await accepted();
    // quotes_check keeps the owner for every writer; the test sets it around the triggers
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set owner_id = $2 where id = $1", [b.quote, admin.id]);
    });
    await cancel(admin, b.quote, "סיבה");
    expect(await asAdmin(async (q) => (await one<{ c: number }>(q, "select count(*)::int as c from public.notifications where entity_id = $1 and title like 'הצעת מחיר שאושרה בוטלה%'", [b.quote])).c)).toBe(0);
  });

  it("the customer's link says cancelled: number, title and business only; no prices and no signing", async () => {
    const a = await accepted();
    await cancel(owner, a.quote, "הלקוח ביקש לבטל");
    const shown = await page(a.token);
    expect(Object.keys(shown)).toEqual(["status_page"]);
    const cancelled = shown.status_page as Record<string, unknown>;
    expect(Object.keys(cancelled).sort()).toEqual(["business", "color", "draft_version", "logo", "number", "phone", "replaced", "state", "title", "valid_until"]);
    expect(cancelled).toMatchObject({ state: "cancelled", title: "שיפוץ מטבח", business: "עסק הביטולים" });
    expect(cancelled.number).toMatch(/\d/);
    expect(JSON.stringify(shown)).not.toMatch(/50000|59000|total|lines|הלקוח ביקש|נועה/);
    // no decision on it
    expect(await asService(async (q) => (await one<{ v: unknown }>(q, "select public.quote_public_version($1) as v", [a.token])).v)).toMatchObject({ fingerprint: null });
    // a quote cancelled before acceptance shows the same status page (owner, 19 October 2026)
    const sent = await asUser(member.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'נשלחה', $2) returning id", [org, a.deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 100)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      const token = (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, id])).t;
      await q("select public.quote_cancel($1, $2)", [org, id]);
      return token;
    });
    expect(await page(sent)).toMatchObject({ status_page: { state: "cancelled" } });
    // a purged customer's quote: not found, as on the normal path
    await asAdmin((q) => q("update public.quotes set customer_deleted_at = now() where id = $1", [a.quote]));
    try {
      expect((await pgError(page(a.token))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.quotes set customer_deleted_at = null where id = $1", [a.quote]));
    }
    // the business's public pages closed: not found
    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org]));
    try {
      expect((await pgError(page(a.token))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("only signed-in people may call it, and the columns are the server's", async () => {
    for (const [role, allowed] of [
      ["anon", false],
      ["authenticated", true],
    ] as const) {
      expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, 'public.quote_cancel_accepted(uuid, uuid, text)', 'execute') as c", [role])).c)).toBe(allowed);
    }
    for (const column of ["cancelled_from", "cancel_reason"]) {
      for (const privilege of ["insert", "update"]) {
        expect(
          await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_column_privilege('authenticated', 'public.quotes', $1, $2) as c", [column, privilege])).c),
          `${column} ${privilege}`,
        ).toBe(false);
      }
    }
  });
});
