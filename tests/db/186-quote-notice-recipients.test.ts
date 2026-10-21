import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * RVW-34: the notices about a quote (accepted or declined, viewed, expired) go to the quote's owner while an active member;
 * else to the current owner of its deal, else of its contact, while an active member; else to every active owner and admin.
 * One rule (app.quote_notice_recipients) for public.quote_public_decide, app.quote_mark_viewed and app.expire_quotes; the
 * content is unchanged (number and title only).
 */
describe("who hears about a quote whose owner left (RVW-34)", () => {
  let owner: U, admin: U, rep: U, dealRep: U, contactRep: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  // a sent quote made by `rep` on a deal with a contact; then the deal and the contact are handed to other people
  const sentQuote = async (opts: { dealOwner?: U | null; contactOwner?: U | null; maker?: U; noDeal?: boolean } = {}) => {
    const maker = opts.maker ?? rep;
    const ids = await asUser(maker.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נועה', $2) returning id", [org, maker.id])).id;
      const deal = opts.noDeal
        ? null
        : (
            await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [
              org,
              pipelineId,
              stageId,
              contact,
              maker.id,
            ])
          ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'שיפוץ', $2, $3) returning id", [org, deal, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 50000)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      const token = (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t;
      return { quote, deal, contact, token };
    });
    if (opts.dealOwner !== undefined && ids.deal) await asAdmin((q) => q("update public.deals set owner_id = $2 where id = $1", [ids.deal, opts.dealOwner?.id ?? null]));
    if (opts.contactOwner !== undefined) await asAdmin((q) => q("update public.contacts set owner_id = $2 where id = $1", [ids.contact, opts.contactOwner?.id ?? null]));
    return ids;
  };
  const recipients = (quote: string, type: string) =>
    asAdmin(async (q) =>
      (await q<{ user_id: string; title: string; body: string | null }>("select user_id, title, body from public.notifications where entity_id = $1 and type = $2 order by user_id", [quote, type])).rows,
    );
  const setRep = (status: "active" | "suspended") => asAdmin((q) => q("update public.memberships set status = $3 where organization_id = $1 and user_id = $2", [org, rep.id, status]));
  const decide = (token: string) =>
    asService(async (q) => {
      const fp = (await one<{ v: { fingerprint: string } }>(q, "select public.quote_public_version($1) as v", [token])).v.fingerprint;
      return (
        await one<{ a: { status: string } }>(
          q,
          `select public.quote_public_decide(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'נועה כהן',
                    p_signature_kind => 'typed', p_wording_version => 'draft-2026-10-18', p_agreed => true) as a`,
          [token, fp],
        )
      ).a;
    });
  const view = (token: string) => asService((q) => q("select public.quote_public($1)", [token]));
  const expire = async (quote: string) => {
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set valid_until = current_date - 3, quote_date = current_date - 30 where id = $1", [quote]);
    });
    await asAdmin((q) => q("select app.expire_quotes()"));
  };
  const sorted = (...users: U[]) => users.map((u) => u.id).sort();

  beforeAll(async () => {
    owner = await createUser("qn-owner");
    org = await createOrg(owner.id, "עסק ההתראות");
    admin = await addMember(org, owner.id, "admin", "qn-admin");
    rep = await addMember(org, owner.id, "member", "qn-rep");
    dealRep = await addMember(org, owner.id, "member", "qn-deal");
    contactRep = await addMember(org, owner.id, "member", "qn-contact");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("an active owner alone hears, as before", async () => {
    const a = await sentQuote({ dealOwner: dealRep });
    await view(a.token);
    expect((await recipients(a.quote, "quote_viewed")).map((r) => r.user_id)).toEqual([rep.id]);
    expect(await decide(a.token)).toEqual({ status: "accepted" });
    expect((await recipients(a.quote, "quote")).map((r) => r.user_id)).toEqual([rep.id]);
  });

  it("a suspended owner: the deal's current owner hears of the view, the answer and the expiry; same content", async () => {
    const a = await sentQuote({ dealOwner: dealRep });
    const b = await sentQuote({ dealOwner: dealRep });
    await setRep("suspended");
    try {
      await view(a.token);
      expect((await recipients(a.quote, "quote_viewed")).map((r) => r.user_id)).toEqual([dealRep.id]);
      expect(await decide(a.token)).toEqual({ status: "accepted" });
      const answered = await recipients(a.quote, "quote");
      expect(answered.map((r) => r.user_id)).toEqual([dealRep.id]);
      expect(answered[0]).toMatchObject({ title: "הצעת מחיר אושרה: שיפוץ" });
      expect(answered[0].body).toMatch(/^הצעה /);
      // the text, not the random ids (a uuid may hold "500")
      expect(answered.map((r) => `${r.title} ${r.body ?? ""}`).join(" ")).not.toMatch(/נועה|500/);
      await expire(b.quote);
      expect((await recipients(b.quote, "quote")).map((r) => r.user_id)).toEqual([dealRep.id]);
    } finally {
      await setRep("active");
    }
  });

  it("a removed owner: a quote without a deal goes to its contact's owner; with a deal, never the contact's owner", async () => {
    // the maker hands the deal and contact on and then leaves the business: the membership is gone
    const gone = await addMember(org, owner.id, "member", "qn-gone");
    const viewer = await addMember(org, owner.id, "viewer", "qn-viewer");
    const contactOnly = await sentQuote({ maker: gone, noDeal: true, contactOwner: contactRep });
    // a deal with no usable owner and a contact with one: quotes_select reads by the deal, so the contact's owner is passed over
    const dealAndContact = await sentQuote({ maker: gone, dealOwner: null, contactOwner: contactRep });
    const nobody = await sentQuote({ maker: gone, dealOwner: null, contactOwner: null });
    const suspendedDealOwner = await sentQuote({ maker: gone, dealOwner: dealRep, contactOwner: null });
    const viewerDealOwner = await sentQuote({ maker: gone, dealOwner: viewer, contactOwner: null });
    await asAdmin((q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, gone.id]));
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, dealRep.id]));
    try {
      await view(contactOnly.token);
      expect((await recipients(contactOnly.quote, "quote_viewed")).map((r) => r.user_id)).toEqual([contactRep.id]);
      await view(dealAndContact.token);
      expect((await recipients(dealAndContact.quote, "quote_viewed")).map((r) => r.user_id)).toEqual(sorted(owner, admin));
      await view(nobody.token);
      expect((await recipients(nobody.quote, "quote_viewed")).map((r) => r.user_id)).toEqual(sorted(owner, admin));
      expect(await decide(nobody.token)).toEqual({ status: "accepted" });
      expect((await recipients(nobody.quote, "quote")).map((r) => r.user_id)).toEqual(sorted(owner, admin));
      // a suspended deal owner is passed over like a missing one, and so is a viewer
      await expire(suspendedDealOwner.quote);
      expect((await recipients(suspendedDealOwner.quote, "quote")).map((r) => r.user_id)).toEqual(sorted(owner, admin));
      await view(viewerDealOwner.token);
      expect((await recipients(viewerDealOwner.quote, "quote_viewed")).map((r) => r.user_id)).toEqual(sorted(owner, admin));
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, dealRep.id]));
    }
  });

  it("the rule is the server's own: no role may call it", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(
        await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, 'app.quote_notice_recipients(public.quotes)', 'execute') as c", [role])).c),
        role,
      ).toBe(false);
    }
  });
});
