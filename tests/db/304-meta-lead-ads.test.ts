import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dbErrorMessage } from "@/lib/errors";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Answer = Record<string, unknown>;
type Claimed = { arrival: string; lease: string; meta_lead_id: string; organization_id: string; integration_id: string; page_id: string; ciphertext: string };

const envelope = (body: string) => `ps1.1.AAAAAAAAAAAAAAAA.${body}.BBBBBBBBBBBBBBBBBBBBBB`;

/**
 * CAP-11: the Meta Lead Ads webhook, in the approved pattern (owner (126) א): service_role-only definer functions, no
 * direct table access; the lead goes through intake_submit with the source "פייסבוק/אינסטגרם"; a Meta lead id is taken once
 * per business; arrivals that failed are claimed again by the sweep; nothing beyond what is needed is returned, and no
 * business reaches another's page, arrivals or leads.
 */
describe("Meta Lead Ads (CAP-11)", () => {
  let owner: U, admin: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let conn: string, otherConn: string;
  let seq = (process.pid % 100000) * 1000;
  const id = () => String(7000000000 + (seq += 1));
  let pageId: string, otherPage: string;

  const receive = (page: string, leads: unknown[]) =>
    asService(async (q) => (await q<{ r: Answer }>("select public.meta_lead_receive($1, $2) as r", [page, JSON.stringify(leads)])).rows[0].r);
  const claim = (limit = 20, ids: string[] | null = null) =>
    asService(async (q) => (await q<{ r: Claimed[] }>("select public.meta_lead_claim($1, $2::uuid[]) as r", [limit, ids])).rows[0].r);
  const finish = (c: Claimed, lead: Answer | null, error: string | null = null) =>
    asService(
      async (q) =>
        (await q<{ r: string }>("select public.meta_lead_finish($1, $2, $3, $4) as r", [c.arrival, c.lease, lead === null ? null : JSON.stringify(lead), error])).rows[0].r,
    );
  const arrival = (arrivalId: string) =>
    asAdmin(async (q) => (await q<Answer>("select * from app.meta_lead_arrivals where id = $1", [arrivalId])).rows[0]);
  const makeConnection = async (who: U, o: string, page: string) =>
    asUser(who.id, async (q) => {
      const made = (await q<{ id: string }>("insert into public.integrations (organization_id, provider, external_id, name) values ($1, 'meta_lead_ads', $2, 'הדף') returning id", [o, page])).rows[0].id;
      await q("select public.integration_secret_set($1, $2, $3, 1)", [o, made, envelope(`VG9rZW4${o.slice(0, 4)}`)]);
      return made;
    });
  /** receive one lead and claim it */
  const arrive = async (page: string, metaForm: string | null = null) => {
    const leadId = id();
    const got = await receive(page, [{ id: leadId, form_id: metaForm }]);
    const ids = got.arrivals as string[];
    const claimed = await claim(20, ids);
    return { leadId, claimed: claimed[0], got };
  };

  beforeAll(async () => {
    owner = await createUser("meta-owner");
    org = await createOrg(owner.id, "עסק הלידים");
    admin = await addMember(org, owner.id, "admin", "meta-admin");
    member = await addMember(org, owner.id, "member", "meta-member");
    viewer = await addMember(org, owner.id, "viewer", "meta-viewer");
    outsider = await createUser("meta-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    pageId = id();
    otherPage = id();
    conn = await makeConnection(owner, org, pageId);
    otherConn = await makeConnection(outsider, otherOrg, otherPage);
  });

  it("a connection comes with its default form row and an intake form of kind 'meta' with the source made once", async () => {
    const rows = await asUser(owner.id, async (q) => (await q<Answer>("select meta_form_id, name, assign_mode, is_active from public.meta_lead_forms where integration_id = $1", [conn])).rows);
    expect(rows).toEqual([{ meta_form_id: null, name: "כל הטפסים בדף", assign_mode: "round_robin", is_active: true }]);
    const form = await asAdmin(async (q) =>
      (
        await q<Answer>(
          `select f.kind, f.name, s.name as source, s.kind as source_kind from public.forms f
             join public.meta_lead_forms m on m.organization_id = f.organization_id and m.id = f.meta_lead_form_id
             join public.lead_sources s on s.organization_id = f.organization_id and s.id = f.source_id
            where m.integration_id = $1`,
          [conn],
        )
      ).rows[0],
    );
    expect(form).toMatchObject({ kind: "meta", name: "פייסבוק/אינסטגרם: כל הטפסים בדף", source: "פייסבוק/אינסטגרם", source_kind: "meta" });
    // a person neither makes, changes nor removes a meta form, nor removes the default row
    expect(await pgError(asUser(owner.id, (q) => q("insert into public.forms (organization_id, kind, name) values ($1, 'meta', 'x')", [org])))).toMatchObject({ hint: "form:meta" });
    expect(await pgError(asUser(owner.id, (q) => q("update public.forms set owner_id = null where organization_id = $1 and kind = 'meta'", [org])))).toMatchObject({ hint: "form:meta" });
    expect(await pgError(asUser(owner.id, (q) => q("delete from public.forms where organization_id = $1 and kind = 'meta'", [org])))).toMatchObject({ hint: "form:meta" });
    expect(await pgError(asUser(owner.id, (q) => q("delete from public.meta_lead_forms where integration_id = $1 and meta_form_id is null", [conn])))).toMatchObject({ hint: "meta_lead_form:default" });
    // a meta form's token is not a web form's
    const token = await asAdmin(async (q) => (await q<{ token: string }>("select token from public.forms where organization_id = $1 and kind = 'meta' limit 1", [org])).rows[0].token);
    expect((await pgError(asService((q) => q("select public.intake_submit($1, 'form', $2)", [token, JSON.stringify({ full_name: "x", phone: "050-1111111" })])))).code).toBe("P0002");
  });

  it("a fetched lead becomes a lead through intake_submit: its source, its Meta id, only the outcome answered", async () => {
    const { leadId, claimed, got } = await arrive(pageId);
    expect(got).toEqual({ status: "ok", new: 1, arrivals: [claimed.arrival] });
    expect(Object.keys(claimed).sort()).toEqual(["arrival", "ciphertext", "integration_id", "lease", "meta_lead_id", "organization_id", "page_id"]);
    expect(claimed).toMatchObject({ meta_lead_id: leadId, organization_id: org, integration_id: conn, page_id: pageId });
    expect(claimed.ciphertext).toMatch(/^ps1\./);
    const out = await finish(claimed, {
      full_name: "ליד מפייסבוק",
      phone: "050-6661234",
      email: "fb@example.test",
      company_name: "חברה",
      message: "שאלה: תשובה",
      platform: "ig",
      campaign: "קמפיין חורף",
      // anything else is dropped
      owner_id: owner.id,
      status_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(out).toBe("accepted");
    const lead = await asAdmin(async (q) =>
      (
        await q<Answer>(
          `select l.full_name, l.phone, l.email, l.company_name, l.message, l.meta_lead_id, l.utm, l.campaign, s.name as source
             from public.leads l join public.lead_sources s on s.organization_id = l.organization_id and s.id = l.source_id
            where l.organization_id = $1 and l.meta_lead_id = $2`,
          [org, leadId],
        )
      ).rows[0],
    );
    expect(lead).toMatchObject({
      full_name: "ליד מפייסבוק",
      email: "fb@example.test",
      company_name: "חברה",
      message: "שאלה: תשובה",
      meta_lead_id: leadId,
      source: "פייסבוק/אינסטגרם",
      campaign: "קמפיין חורף",
      utm: { utm_source: "instagram", utm_medium: "lead_ads", utm_campaign: "קמפיין חורף" },
    });
    expect(await arrival(claimed.arrival)).toMatchObject({ status: "done", outcome: "accepted", lease: null });
    // the arrival keeps ids and codes only
    expect(JSON.stringify(await arrival(claimed.arrival))).not.toContain("050-6661234");
  });

  it("a repeated Meta lead id is taken once: a second webhook adds nothing and nothing is claimed again", async () => {
    const { leadId, claimed } = await arrive(pageId);
    expect(await finish(claimed, { full_name: "פעם אחת", phone: "050-6662222" })).toBe("accepted");
    const again = await receive(pageId, [{ id: leadId }, { id: leadId }]);
    expect(again).toEqual({ status: "ok", new: 0, arrivals: [] });
    expect(await asAdmin((q) => count(q, "select 1 from app.meta_lead_arrivals where organization_id = $1 and meta_lead_id = $2", [org, leadId]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and meta_lead_id = $2", [org, leadId]))).toBe(1);
    // a finished arrival cannot be finished again, nor with a stale lease
    expect(await finish(claimed, { full_name: "שוב", phone: "050-6663333" })).toBe("stale");
    // a browser cannot set the Meta id (server-only) nor reuse one in the business
    expect((await pgError(asUser(owner.id, (q) => q("update public.leads set meta_lead_id = 'x' where organization_id = $1", [org])))).code).toBe("42501");
    const dup = await pgError(
      asAdmin((q) =>
        q(
          "insert into public.leads (organization_id, status_id, full_name, meta_lead_id) select $1, s.id, 'כפול', $2 from public.lead_statuses s where s.organization_id = $1 limit 1",
          [org, leadId],
        ),
      ),
    );
    expect(dup.code).toBe("23505");
  });

  it("the same Meta lead id in another business is that business's own", async () => {
    const leadId = id();
    const mine = await receive(pageId, [{ id: leadId }]);
    const theirs = await receive(otherPage, [{ id: leadId }]);
    expect(mine.new).toBe(1);
    expect(theirs.new).toBe(1);
    const claimed = await claim(20, [...(mine.arrivals as string[]), ...(theirs.arrivals as string[])]);
    expect(claimed.map((c) => c.organization_id).sort()).toEqual([org, otherOrg].sort());
    for (const c of claimed) expect(await finish(c, { full_name: "שני עסקים", phone: "050-6664444" })).toBe("accepted");
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where meta_lead_id = $1", [leadId]))).toBe(2);
    // each envelope is its own connection's
    expect(claimed.find((c) => c.organization_id === otherOrg)?.integration_id).toBe(otherConn);
  });

  it("an unknown or disconnected page takes nothing; bad input is refused; only the page's business is touched", async () => {
    expect(await receive(id(), [{ id: id() }])).toEqual({ status: "unknown_page" });
    expect((await pgError(receive("not-a-page", [{ id: id() }]))).code).toBe("22023");
    expect((await pgError(receive(pageId, Array.from({ length: 101 }, () => ({ id: id() }))))).code).toBe("22023");
    // malformed ids are skipped, a malformed form id is kept as none
    const skipped = await receive(pageId, [{ id: "abc" }, { id: 5 }, { id: id(), form_id: "x" }]);
    expect(skipped.new).toBe(1);
    const page = id();
    const off = await makeConnection(admin, org, page);
    await asUser(owner.id, (q) => q("update public.integrations set status = 'disconnected' where id = $1", [off]));
    expect(await receive(page, [{ id: id() }])).toEqual({ status: "unknown_page" });
  });

  it("a mapped form sends its leads to its own person; a form switched off refuses them", async () => {
    const metaForm = id();
    await asUser(admin.id, (q) =>
      q("insert into public.meta_lead_forms (organization_id, integration_id, meta_form_id, name, assign_mode, owner_id) values ($1, $2, $3, 'טופס הקיץ', 'owner', $4)", [
        org,
        conn,
        metaForm,
        member.id,
      ]),
    );
    const { leadId, claimed } = await arrive(pageId, metaForm);
    expect(await finish(claimed, { full_name: "לטופס הקיץ", phone: "050-6665555" })).toBe("accepted");
    const owned = await asAdmin(async (q) => (await q<{ owner_id: string }>("select owner_id from public.leads where organization_id = $1 and meta_lead_id = $2", [org, leadId])).rows[0]);
    expect(owned.owner_id).toBe(member.id);
    // the person must be an active member who is not a viewer
    expect(
      await pgError(asUser(admin.id, (q) => q("update public.meta_lead_forms set owner_id = $2 where meta_form_id = $1", [metaForm, viewer.id]))),
    ).toMatchObject({ hint: "meta_lead_form:owner" });
    await asUser(admin.id, (q) => q("update public.meta_lead_forms set is_active = false where meta_form_id = $1", [metaForm]));
    const second = await arrive(pageId, metaForm);
    expect(await finish(second.claimed, { full_name: "כבוי", phone: "050-6666666" })).toBe("refused");
    expect(await arrival(second.claimed.arrival)).toMatchObject({ status: "refused", last_error_code: "form_off" });
  });

  it("errors: retried later and claimed again by the sweep; not found ends it; a bad token marks the connection", async () => {
    const { claimed } = await arrive(pageId);
    expect(await finish(claimed, null, "graph_unavailable")).toBe("retry");
    const waiting = await arrival(claimed.arrival);
    expect(waiting).toMatchObject({ status: "pending", attempts: 1, last_error_code: "graph_unavailable", lease: null });
    // not due yet: the sweep does not take it
    expect((await claim(100, [claimed.arrival])).length).toBe(0);
    await asAdmin((q) => q("update app.meta_lead_arrivals set next_try_at = now() - interval '1 second' where id = $1", [claimed.arrival]));
    const swept = await claim(100, [claimed.arrival]);
    expect(swept.length).toBe(1);
    expect(await finish(swept[0], { full_name: "אחרי הכשל", phone: "050-6667777" })).toBe("accepted");
    expect(await arrival(claimed.arrival)).toMatchObject({ status: "done", attempts: 2 });

    const gone = await arrive(pageId);
    expect(await finish(gone.claimed, null, "not_found")).toBe("refused");

    const bad = await arrive(pageId);
    expect(await finish(bad.claimed, null, "token_invalid")).toBe("retry");
    expect((await asUser(owner.id, (q) => q<Answer>("select status, last_error_code from public.integrations where id = $1", [conn]))).rows[0]).toEqual({
      status: "error",
      last_error_code: "token_invalid",
    });
    // a saved new token connects it again
    await asUser(owner.id, (q) => q("select public.integration_secret_set($1, $2, $3, 1)", [org, conn, envelope("TmV3VG9rZW4")]));
    expect((await asUser(owner.id, (q) => q<Answer>("select status from public.integrations where id = $1", [conn]))).rows[0].status).toBe("connected");
    // a free-text error is never stored as such
    const odd = await arrive(pageId);
    expect(await finish(odd.claimed, null, "Error: user 050-123 failed")).toBe("retry");
    expect((await arrival(odd.claimed.arrival)).last_error_code).toBe("error");
  });

  it("a leased arrival is not claimed twice; after three days it is given up and the owners told once", async () => {
    const { claimed } = await arrive(pageId);
    expect((await claim(100, [claimed.arrival])).length).toBe(0);
    await asAdmin((q) => q("update app.meta_lead_arrivals set lease_until = now() - interval '1 second', received_at = now() - interval '4 days' where id = $1", [claimed.arrival]));
    expect((await claim(100, [claimed.arrival])).length).toBe(0);
    expect((await arrival(claimed.arrival)).status).toBe("given_up");
    const notices = await asAdmin((q) =>
      count(q, "select 1 from public.notifications where organization_id = $1 and title = 'פניות מפייסבוק/אינסטגרם לא נקלטו'", [org]),
    );
    expect(notices).toBe(2); // owner and admin
    // the lease it held is useless now
    expect(await finish(claimed, { full_name: "מאוחר", phone: "050-6668888" })).toBe("stale");
  });

  it("bad lead data is refused, not retried; a business that takes no leads refuses too", async () => {
    const { claimed } = await arrive(pageId);
    expect(await finish(claimed, { platform: "fb" })).toBe("refused");
    expect(await arrival(claimed.arrival)).toMatchObject({ status: "refused", last_error_code: "invalid" });
    const later = await arrive(pageId);
    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org]));
    try {
      expect(await finish(later.claimed, { full_name: "סגור", phone: "050-6669999" })).toBe("refused");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("the receive limit: 1,000 new arrivals per connection an hour", async () => {
    await asAdmin((q) => q("update app.meta_lead_receive_counts set received = 999, window_start = now() where integration_id = $1", [conn]));
    const got = await receive(pageId, [{ id: id() }, { id: id() }, { id: id() }]);
    expect(got).toMatchObject({ status: "rate_limited", new: 1 });
    expect(await receive(pageId, [{ id: id() }])).toMatchObject({ status: "rate_limited", new: 0 });
    await asAdmin((q) => q("update app.meta_lead_receive_counts set window_start = now() - interval '2 hours' where integration_id = $1", [conn]));
    expect(await receive(pageId, [{ id: id() }])).toMatchObject({ status: "ok", new: 1 });
  });

  it("only the service role calls the webhook functions; the summary is for owners and admins of the business", async () => {
    for (const run of [asAnon, (fn: Parameters<typeof asAnon>[0]) => asUser(owner.id, fn)]) {
      expect((await pgError(run((q) => q("select public.meta_lead_receive('1', '[]')"))))).toMatchObject({ code: "42501" });
      expect((await pgError(run((q) => q("select public.meta_lead_claim(1, null)"))))).toMatchObject({ code: "42501" });
      expect((await pgError(run((q) => q("select public.meta_lead_finish(gen_random_uuid(), gen_random_uuid(), null, 'x')"))))).toMatchObject({ code: "42501" });
      expect((await pgError(run((q) => q("select * from app.meta_lead_arrivals"))))).toMatchObject({ code: "42501" });
    }
    const summary = await asUser(admin.id, async (q) => (await q<{ r: Record<string, Answer> }>("select public.meta_lead_summary($1) as r", [org])).rows[0].r);
    expect(Object.keys(summary)).toContain(conn);
    expect(Object.keys(summary)).not.toContain(otherConn);
    expect(Object.keys(summary[conn]).sort()).toEqual(["done", "given_up", "last_received_at", "pending", "refused", "verified"]);
    for (const who of [member, viewer, outsider]) {
      expect((await pgError(asUser(who.id, (q) => q("select public.meta_lead_summary($1)", [org]))))).toMatchObject({ code: "42501" });
    }
    // no business maps a form onto another's connection: the same answer as for an id that does not exist
    const mapOnto = (target: string) =>
      pgError(asUser(owner.id, (q) => q("insert into public.meta_lead_forms (organization_id, integration_id, name) values ($1, $2, 'x')", [org, target])));
    expect(await mapOnto(otherConn)).toMatchObject({ code: "P0001", hint: "meta_lead_form:integration" });
    expect(await mapOnto("00000000-0000-4000-8000-000000000000")).toMatchObject({ code: "P0001", hint: "meta_lead_form:integration" });
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.meta_lead_forms where integration_id = $1", [otherConn]))).toBe(0);
  });

  it("the plan key meta_leads (143) ב: no connection, no form switched on and no lead without it", async () => {
    const setKey = (on: boolean | null) =>
      asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, on === null ? "{}" : JSON.stringify({ meta_leads: on })]));
    // arrivals that came while the key was there, one leased already
    const waiting = await receive(pageId, [{ id: id() }]);
    const leased = await arrive(pageId);
    const metaForm = id();
    await asUser(admin.id, (q) =>
      q("insert into public.meta_lead_forms (organization_id, integration_id, meta_form_id, name, is_active) values ($1, $2, $3, 'כבוי מראש', false)", [org, conn, metaForm]),
    );
    await setKey(false);
    try {
      // connecting a page, a page going live again and a form switched on are refused, for every writer
      expect(
        await pgError(asUser(owner.id, (q) => q("insert into public.integrations (organization_id, provider, external_id, name) values ($1, 'meta_lead_ads', $2, 'x')", [org, id()]))),
      ).toMatchObject({ code: "P0001", hint: "feature:meta_leads" });
      expect(
        await pgError(asUser(admin.id, (q) => q("update public.meta_lead_forms set is_active = true where integration_id = $1 and meta_form_id = $2", [conn, metaForm]))),
      ).toMatchObject({ code: "P0001", hint: "feature:meta_leads" });
      await asUser(owner.id, (q) => q("update public.integrations set status = 'disconnected' where id = $1", [conn]));
      expect(await pgError(asUser(owner.id, (q) => q("update public.integrations set status = 'connected' where id = $1", [conn])))).toMatchObject({
        hint: "feature:meta_leads",
      });
      expect(await pgError(asUser(owner.id, (q) => q("select public.integration_secret_set($1, $2, $3, 1)", [org, conn, envelope("S2V5T2Zm")])))).toMatchObject({
        hint: "feature:meta_leads",
      });
      // the server makes no lead: the claim ends the waiting one, the finish the leased one; both counted as not taken
      expect((await claim(100, waiting.arrivals as string[])).length).toBe(0);
      expect(await arrival((waiting.arrivals as string[])[0])).toMatchObject({ status: "refused", last_error_code: "feature_off" });
      expect(await finish(leased.claimed, { full_name: "בלי מפתח", phone: "050-6661111" })).toBe("refused");
      expect(await arrival(leased.claimed.arrival)).toMatchObject({ status: "refused", last_error_code: "feature_off" });
      expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and full_name = 'בלי מפתח'", [org]))).toBe(0);
      // switching off and removing stay allowed
      expect(await asUser(admin.id, async (q) => (await q("update public.meta_lead_forms set name = 'עדיין כבוי' where meta_form_id = $1", [metaForm])).rowCount)).toBe(1);
      expect(await asUser(admin.id, async (q) => (await q("delete from public.meta_lead_forms where meta_form_id = $1", [metaForm])).rowCount)).toBe(1);
    } finally {
      await setKey(null);
      await asUser(owner.id, (q) => q("select public.integration_secret_set($1, $2, $3, 1)", [org, conn, envelope("QmFjaw")]));
    }
    // a personal plan holds the key off; basic and up on
    const plans = await asAdmin(async (q) => (await q<{ key: string; on: boolean | null }>("select key, (features ->> 'meta_leads')::boolean as on from public.plans where key in ('personal', 'basic', 'pro', 'business') order by position")).rows);
    expect(Object.fromEntries(plans.map((p) => [p.key, p.on]))).toEqual({ personal: false, basic: true, pro: true, business: true });
  });

  it("finished arrivals are removed after 12 months (147) ב; pending ones and newer ones stay", async () => {
    const got = await receive(pageId, [{ id: id() }, { id: id() }, { id: id() }]);
    const [oldDone, newDone, pending] = got.arrivals as string[];
    await asAdmin(async (q) => {
      await q("update app.meta_lead_arrivals set status = 'done', done_at = now() - interval '13 months' where id = $1", [oldDone]);
      await q("update app.meta_lead_arrivals set status = 'refused', done_at = now() - interval '11 months' where id = $1", [newDone]);
      await q("update app.meta_lead_arrivals set received_at = now() - interval '2 days' where id = $1", [pending]);
    });
    const removed = await asAdmin(async (q) => (await q<{ n: number }>("select app.purge_old_meta_lead_arrivals() as n")).rows[0].n);
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await asAdmin(async (q) => (await q<{ id: string }>("select id from app.meta_lead_arrivals where id = any($1::uuid[])", [[oldDone, newDone, pending]])).rows.map((r) => r.id));
    expect(left.sort()).toEqual([newDone, pending].sort());
    for (const run of [asAnon, asService, (fn: Parameters<typeof asAnon>[0]) => asUser(owner.id, fn)]) {
      expect((await pgError(run((q) => q("select app.purge_old_meta_lead_arrivals()")))).code).toBe("42501");
    }
  });

  // review of 8 November 2026, finding 1: page squatting
  describe("a page is proven only by a lead fetched with the business's own token", () => {
    const status = (who: U, integration: string) =>
      asUser(who.id, async (q) =>
        (await q<Answer>("select status, last_error_code, verified_at is not null as verified from public.integrations where id = $1", [integration])).rows[0],
      );
    // straight through PostgREST: no page check, a well-shaped junk envelope
    const squat = async (page: string) =>
      asUser(outsider.id, async (q) => {
        const made = (
          await q<{ id: string }>("insert into public.integrations (organization_id, provider, external_id, name) values ($1, 'meta_lead_ads', $2, 'לא שלי') returning id", [
            otherOrg,
            page,
          ])
        ).rows[0].id;
        expect((await q<{ r: string }>("select public.integration_secret_set($1, $2, $3, 1) as r", [otherOrg, made, envelope("SnVuaw")])).rows[0].r).toBe("connected");
        return made;
      });

    it("a squatter blocks nobody, sees no counts, and is evicted by the real owner's first lead", async () => {
      const page = id();
      const squatter = await squat(page);
      // the real owner is not blocked
      const real = await makeConnection(admin, org, page);
      expect(await status(admin, real)).toMatchObject({ status: "connected", verified: false });
      // until a connection is verified, the page's leads reach both; the squatter's screen shows no counts
      const got = await receive(page, [{ id: id() }]);
      expect(got).toMatchObject({ status: "ok", new: 2 });
      const theirSummary = await asUser(outsider.id, async (q) => (await q<{ r: Record<string, Answer> }>("select public.meta_lead_summary($1) as r", [otherOrg])).rows[0].r);
      expect(theirSummary[squatter]).toEqual({ verified: false });
      const claimed = await claim(20, got.arrivals as string[]);
      const mine = claimed.find((c) => c.integration_id === real) as Claimed;
      const theirs = claimed.find((c) => c.integration_id === squatter) as Claimed;
      // the real owner's fetch succeeds: verified, and the squatter is ended with every pending arrival
      expect(await finish(mine, { full_name: "ליד של הבעלים", phone: "050-6612345" })).toBe("accepted");
      expect(await status(admin, real)).toMatchObject({ status: "connected", verified: true });
      expect(await status(outsider, squatter)).toMatchObject({ status: "error", last_error_code: "page_taken", verified: false });
      expect(await arrival(theirs.arrival)).toMatchObject({ status: "refused", last_error_code: "page_taken" });
      expect(await finish(theirs, { full_name: "גנוב", phone: "050-6654321" })).toBe("stale");
      expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and full_name = 'גנוב'", [otherOrg]))).toBe(0);
      // from now on only the verified connection takes the page's leads
      const next = await receive(page, [{ id: id() }]);
      expect(next).toMatchObject({ status: "ok", new: 1 });
      expect(await asAdmin((q) => count(q, "select 1 from app.meta_lead_arrivals where id = any($1::uuid[]) and organization_id = $2", [next.arrivals, org]))).toBe(1);
      // the squatter cannot come back, and no other business can take the verified page (the owner's text, (144) א)
      expect(await pgError(asUser(outsider.id, (q) => q("update public.integrations set status = 'connected' where id = $1", [squatter])))).toMatchObject({
        hint: "integration:taken",
      });
      const third = await createUser("meta-third");
      const thirdOrg = await createOrg(third.id, "עסק שלישי");
      const attempt = await pgError(
        asUser(third.id, async (q) => {
          const made = (
            await q<{ id: string }>("insert into public.integrations (organization_id, provider, external_id, name) values ($1, 'meta_lead_ads', $2, 'x') returning id", [thirdOrg, page])
          ).rows[0].id;
          await q("select public.integration_secret_set($1, $2, $3, 1)", [thirdOrg, made, envelope("VGhpcmQ")]);
        }),
      );
      expect(attempt).toMatchObject({ code: "P0001", hint: "integration:taken" });
      expect(dbErrorMessage(attempt)).toBe("הדף הזה כבר מחובר לעסק אחר במקסוז");
    });

    it("a squatter's token or envelope error ends it at once, with no three-day retry and no counts", async () => {
      const page = id();
      const squatter = await squat(page);
      const got = await receive(page, [{ id: id() }, { id: id() }]);
      const claimed = await claim(1, [(got.arrivals as string[])[0]]);
      expect(await finish(claimed[0], null, "secret_unreadable")).toBe("refused");
      expect(await status(outsider, squatter)).toMatchObject({ status: "error", last_error_code: "secret_unreadable" });
      // its other pending arrival ended too
      expect(await asAdmin((q) => count(q, "select 1 from app.meta_lead_arrivals where integration_id = $1 and status = 'pending'", [squatter]))).toBe(0);
      const theirSummary = await asUser(outsider.id, async (q) => (await q<{ r: Record<string, Answer> }>("select public.meta_lead_summary($1) as r", [otherOrg])).rows[0].r);
      expect(theirSummary[squatter]).toEqual({ verified: false });
      // a verified connection keeps retrying the same code (it is the page's)
      const { claimed: ok } = await arrive(pageId);
      expect(await finish(ok, null, "secret_unreadable")).toBe("retry");
    });

    // re-review N1
    it("an ended squatter takes no arrival on the next webhook and is never claimed; a new token is refused while the page is verified", async () => {
      const page = id();
      const squatter = await squat(page);
      const real = await makeConnection(admin, org, page);
      const first = await receive(page, [{ id: id() }]);
      const claimed = await claim(20, first.arrivals as string[]);
      expect(await finish(claimed.find((c) => c.integration_id === real) as Claimed, { full_name: "המחזיק", phone: "050-6630001" })).toBe("accepted");
      // the next webhook makes an arrival for the verified connection only
      const next = await receive(page, [{ id: id() }]);
      expect(next).toMatchObject({ status: "ok", new: 1 });
      expect(await asAdmin((q) => count(q, "select 1 from app.meta_lead_arrivals where integration_id = $1 and status = 'pending'", [squatter]))).toBe(0);
      // an arrival of it made by hand is never claimed
      const planted = await asAdmin(async (q) =>
        (
          await q<{ id: string }>("insert into app.meta_lead_arrivals (organization_id, integration_id, meta_lead_id) values ($1, $2, $3) returning id", [
            otherOrg,
            squatter,
            id(),
          ])
        ).rows[0].id,
      );
      expect(await claim(100, [planted])).toEqual([]);
      // and saving a new token goes through the going-live check: refused while the page is verified
      expect(await pgError(asUser(outsider.id, (q) => q("select public.integration_secret_set($1, $2, $3, 1)", [otherOrg, squatter, envelope("TmV3")])))).toMatchObject({
        hint: "integration:taken",
      });
    });

    it("an ended unverified connection (secret_unreadable) takes no arrival and is not claimed", async () => {
      const page = id();
      const squatter = await squat(page);
      const got = await receive(page, [{ id: id() }]);
      const claimed = await claim(20, got.arrivals as string[]);
      expect(await finish(claimed[0], null, "secret_unreadable")).toBe("refused");
      expect(await receive(page, [{ id: id() }])).toEqual({ status: "unknown_page" });
      expect(await status(outsider, squatter)).toMatchObject({ status: "error", last_error_code: "secret_unreadable" });
    });

    it("receive answers a verified connection's arrivals first, then the older connections' (until one is verified)", async () => {
      const page = id();
      const older = await squat(page);
      const newer = await makeConnection(owner, org, page);
      const got = await receive(page, [{ id: id() }]);
      const owners = await asAdmin(async (q) =>
        (await q<{ id: string; integration_id: string }>("select id, integration_id from app.meta_lead_arrivals where id = any($1::uuid[])", [got.arrivals])).rows,
      );
      const byId = new Map(owners.map((r) => [r.id, r.integration_id]));
      expect((got.arrivals as string[]).map((a) => byId.get(a))).toEqual([older, newer]);
    });

    // re-review N3
    it("a real owner's first token_invalid keeps the waiting leads; after a new token they are claimed and the lead made", async () => {
      const page = id();
      const real = await makeConnection(owner, org, page);
      const got = await receive(page, [{ id: id() }, { id: id() }]);
      const [a1, a2] = got.arrivals as string[];
      const first = await claim(1, [a1]);
      expect(await finish(first[0], null, "token_invalid")).toBe("retry");
      expect(await status(owner, real)).toMatchObject({ status: "error", last_error_code: "token_invalid", verified: false });
      // both still wait; the ended connection is neither claimed nor sent new arrivals
      expect(await asAdmin((q) => count(q, "select 1 from app.meta_lead_arrivals where id = any($1::uuid[]) and status = 'pending'", [[a1, a2]]))).toBe(2);
      expect(await claim(100, [a1, a2])).toEqual([]);
      expect(await receive(page, [{ id: id() }])).toEqual({ status: "unknown_page" });
      // a new token opens it again
      await asUser(owner.id, (q) => q("select public.integration_secret_set($1, $2, $3, 1)", [org, real, envelope("UmVuZXdlZA")]));
      await asAdmin((q) => q("update app.meta_lead_arrivals set next_try_at = now() where id = any($1::uuid[])", [[a1, a2]]));
      const again = await claim(100, [a1, a2]);
      expect(again.map((c) => c.arrival).sort()).toEqual([a1, a2].sort());
      for (const [i, c] of again.entries()) expect(await finish(c, { full_name: `אחרי טוקן חדש ${i}`, phone: `050-664000${i}` })).toBe("accepted");
      expect(await status(owner, real)).toMatchObject({ status: "connected", verified: true });
      expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and full_name like 'אחרי טוקן חדש%'", [org]))).toBe(2);
    });

    // re-review N2: the lock order, page lock before the connection's row
    it("finish waits for the page lock, and never waits for its connection's row (taken skip locked)", async () => {
      const page = id();
      const real = await makeConnection(owner, org, page);
      const got = await receive(page, [{ id: id() }]);
      const [c] = await claim(20, got.arrivals as string[]);
      const holder = new Client({ connectionString: TEST_DB_URL });
      await holder.connect();
      try {
        // another transaction holds the page lock: finish waits for it (here until its statement timeout)
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`meta_page:${page}`]);
        const waited = await pgError(
          asService(async (q) => {
            await q("set local statement_timeout = '400ms'");
            await q("select public.meta_lead_finish($1, $2, $3, null)", [c.arrival, c.lease, JSON.stringify({ full_name: "x", phone: "050-6650001" })]);
          }),
        );
        expect(waited.code).toBe("57014");
        await holder.query("rollback");
        // another transaction holds the connection's row (as a person's status update would): finish does not wait
        await holder.query("begin");
        await holder.query("select 1 from public.integrations where id = $1 for update", [real]);
        const answer = await asService(async (q) => {
          await q("set local statement_timeout = '2s'");
          return (await q<{ r: string }>("select public.meta_lead_finish($1, $2, $3, null) as r", [c.arrival, c.lease, JSON.stringify({ full_name: "x", phone: "050-6650001" })])).rows[0].r;
        });
        expect(answer).toBe("retry");
        await holder.query("rollback");
        expect(await arrival(c.arrival)).toMatchObject({ status: "pending", lease: null });
      } finally {
        await holder.query("rollback").catch(() => undefined);
        await holder.end();
      }
    });

    it("an unverified connection whose fetch succeeds after the page was verified elsewhere ends itself", async () => {
      const page = id();
      const squatter = await squat(page);
      const real = await makeConnection(owner, org, page);
      const got = await receive(page, [{ id: id() }]);
      const claimed = await claim(20, got.arrivals as string[]);
      const theirs = claimed.find((c) => c.integration_id === squatter) as Claimed;
      const mine = claimed.find((c) => c.integration_id === real) as Claimed;
      expect(await finish(mine, { full_name: "ראשון", phone: "050-6600001" })).toBe("accepted");
      // as if the squatter's own fetch had come back later (still holding its lease)
      await asAdmin((q) =>
        q("update app.meta_lead_arrivals set status = 'pending', done_at = null, lease = $2, lease_until = now() + interval '1 minute' where id = $1", [theirs.arrival, theirs.lease]),
      );
      expect(await finish(theirs, { full_name: "שני", phone: "050-6600002" })).toBe("refused");
      expect(await status(outsider, squatter)).toMatchObject({ status: "error", last_error_code: "page_taken", verified: false });
      expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and full_name = 'שני'", [otherOrg]))).toBe(0);
    });
  });

  it("removing the connection removes its forms, intake forms and arrivals; the leads stay", async () => {
    const page = id();
    const temp = await makeConnection(owner, org, page);
    const got = await receive(page, [{ id: id() }]);
    const claimed = await claim(20, got.arrivals as string[]);
    expect(await finish(claimed[0], { full_name: "נשאר", phone: "050-6660000" })).toBe("accepted");
    await asUser(owner.id, (q) => q("delete from public.integrations where id = $1", [temp]));
    expect(await asAdmin((q) => count(q, "select 1 from public.meta_lead_forms where integration_id = $1", [temp]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from app.meta_lead_arrivals where integration_id = $1", [temp]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and full_name = 'נשאר'", [org]))).toBe(1);
  });
});
