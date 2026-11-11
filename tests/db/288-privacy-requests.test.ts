import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

type Payload = { request_type?: string; name?: string; contact_kind?: string; contact_value?: string; details?: string };
const PAYLOAD: Payload = { request_type: "access", name: "דנה כהן", contact_kind: "email", contact_value: "Dana@Example.com", details: "מה שמור עליי?" };

/**
 * PRK-02: the public privacy-request page (owner, 26 October 2026, wave 3 use (3)): one secret link per business; the page reads
 * only the business's display name and brand; a request stores only type, name, one contact and text, answers the same always,
 * tells the privacy officer and owners/admins with a `system` notice naming nothing personal and a 30-day target; honeypot and
 * keyed-IP rate limits; staff (owners/admins only) verify identity, link a record, move the status; erasure empties it.
 */
describe("privacy requests (PRK-02)", () => {
  let owner: { id: string };
  let admin: { id: string };
  let manager: { id: string };
  let officer: { id: string };
  let other: { id: string };
  let org: string;
  let otherOrg: string;
  let token: string;
  let otherToken: string;

  const page = (t: string, hash: string | null = null) =>
    asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.privacy_request_page($1, $2) as r", [t, hash])).rows[0].r);
  const submit = (t: string, payload: unknown, hash: string | null = null, spam = false) =>
    asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.privacy_request_submit($1, $2, $3, $4) as r", [t, JSON.stringify(payload), hash, spam])).rows[0].r);
  const requests = (o: string) =>
    asAdmin(async (q) => (await q<Record<string, unknown>>("select * from public.privacy_requests where organization_id = $1 order by received_at, id", [o])).rows);
  const resetCounts = () =>
    asAdmin(async (q) => {
      await q("update app.privacy_request_counts set window_start = now() - interval '2 days'");
      await q("update app.privacy_request_notice_days set received = 0, extra_notice_at = null");
      await q("update app.privacy_request_links set view_window_start = null, view_count = 0, submit_window_start = null, submit_count = 0");
    });
  const newRequest = async (o: string, t: string, payload: Payload = PAYLOAD) => {
    await resetCounts();
    await submit(t, payload, HASH_C);
    const rows = await requests(o);
    return rows[rows.length - 1].id as string;
  };

  beforeAll(async () => {
    owner = await createUser("prk2-owner");
    other = await createUser("prk2-other");
    org = await createOrg(owner.id, "העסק של דנה");
    otherOrg = await createOrg(other.id);
    admin = await addMember(org, owner.id, "admin", "prk2-admin");
    manager = await addMember(org, owner.id, "manager", "prk2-manager");
    officer = await addMember(org, owner.id, "member", "prk2-officer");
    await asUser(owner.id, (q) => q("insert into public.org_privacy_settings (organization_id, privacy_officer_id) values ($1, $2)", [org, officer.id]));
    token = await asUser(owner.id, async (q) => (await q<{ t: string }>("select public.privacy_request_link_create($1) as t", [org])).rows[0].t);
    otherToken = await asUser(other.id, async (q) => (await q<{ t: string }>("select public.privacy_request_link_create($1) as t", [otherOrg])).rows[0].t);
  });

  it("only owners and admins make, read and revoke the link; only its hash is kept", async () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    for (const u of [manager, officer, other]) {
      expect((await pgError(asUser(u.id, (q) => q("select public.privacy_request_link_create($1)", [org])))).code, u.id).toBe("42501");
      expect((await pgError(asUser(u.id, (q) => q("select public.privacy_request_link_status($1)", [org])))).code, u.id).toBe("42501");
      expect((await pgError(asUser(u.id, (q) => q("select public.privacy_request_link_revoke($1)", [org])))).code, u.id).toBe("42501");
    }
    const status = await asUser(admin.id, async (q) => (await q<{ s: { active: boolean } }>("select public.privacy_request_link_status($1) as s", [org])).rows[0].s);
    expect(status.active).toBe(true);
    expect(await asAdmin((q) => count(q, "select 1 from app.privacy_request_links where token_hash = $1", [token]))).toBe(0);
    // the API roles reach neither the link table nor the public functions
    expect((await pgError(asUser(owner.id, (q) => q("select * from app.privacy_request_links")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.privacy_request_page($1)", [token])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select public.privacy_request_submit($1, '{}'::jsonb)", [token])))).code).toBe("42501");
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'privacy_request_link' and changes::text like '%' || $2 || '%'", [org, token]))).toBe(0);
  });

  it("the page answers only the business's display name and brand; an unknown token is not found", async () => {
    await resetCounts();
    const answer = await page(token, HASH_A);
    expect(Object.keys(answer).sort()).toEqual(["brand", "built_with", "business"]);
    expect(answer.business).toBe("העסק של דנה");
    expect(Object.keys(answer.brand as object).sort()).toEqual(["color", "logo"]);
    expect((await pgError(page("x".repeat(64)))).code).toBe("P0002");
    expect((await pgError(page("short"))).code).toBe("P0002");
    // each token is its own business
    expect((await page(otherToken)).business).not.toBe("העסק של דנה");
  });

  it("a request is stored with a 30-day target and tells the officer and owners/admins, naming nothing personal", async () => {
    await resetCounts();
    const answer = await submit(token, PAYLOAD, HASH_A);
    expect(answer).toEqual({ status: "received" });
    const rows = await requests(org);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.request_type).toBe("access");
    expect(row.requester_name).toBe("דנה כהן");
    expect(row.contact_value).toBe("dana@example.com");
    expect(row.status).toBe("new");
    const days = await asAdmin(async (q) =>
      (await q<{ d: number }>("select (r.target_date - (r.received_at at time zone 'Asia/Jerusalem')::date) as d from public.privacy_requests r where r.id = $1", [row.id])).rows[0].d,
    );
    expect(days).toBe(30);
    const notices = await asAdmin(async (q) =>
      (await q<{ user_id: string; type: string; title: string; body: string }>("select user_id, type, title, body from public.notifications where organization_id = $1 and entity_type = 'privacy_request'", [org])).rows,
    );
    expect(notices.map((n) => n.user_id).sort()).toEqual([owner.id, admin.id, officer.id].sort());
    for (const n of notices) {
      expect(n.type).toBe("system");
      expect(n.title).toBe("התקבלה בקשת פרטיות חדשה");
      expect(n.body).toMatch(/^מועד יעד: \d{2}\/\d{2}\/\d{4}$/);
      expect(`${n.title} ${n.body}`).not.toContain("דנה");
    }
    // nothing reaches the other business
    expect(await requests(otherOrg)).toHaveLength(0);
  });

  it("the answer is the same whether or not the business holds the person; bad input is refused without data", async () => {
    await insertLead(owner.id, org, { full_name: "יוסי לוי", email: "yossi@example.com" });
    await resetCounts();
    const known = await submit(token, { ...PAYLOAD, name: "יוסי לוי", contact_value: "yossi@example.com" }, HASH_A);
    const unknown = await submit(token, { ...PAYLOAD, name: "אף אחד", contact_value: "nobody@example.com" }, HASH_B);
    expect(known).toEqual(unknown);
    for (const bad of [
      { ...PAYLOAD, request_type: "delete_all" },
      { ...PAYLOAD, name: "  " },
      { ...PAYLOAD, contact_kind: "fax" },
      { ...PAYLOAD, contact_value: "not-an-email" },
      { ...PAYLOAD, contact_kind: "phone", contact_value: "12" },
      { ...PAYLOAD, details: "א".repeat(2001) },
    ]) {
      const refused = await pgError(submit(token, bad, HASH_C));
      expect(refused.code).toBe("22023");
      expect(refused.hint).toBe("privacy_request:invalid");
    }
    // the request is not linked to anything automatically
    const rows = await requests(org);
    expect(rows.every((r) => r.lead_id === null && r.contact_id === null)).toBe(true);
  });

  it("a honeypot hit answers like the rest, stores nothing and tells no one", async () => {
    await resetCounts();
    const before = (await requests(org)).length;
    const notices = await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and entity_type = 'privacy_request'", [org]));
    expect(await submit(token, PAYLOAD, HASH_A, true)).toEqual({ status: "received" });
    expect((await requests(org)).length).toBe(before);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and entity_type = 'privacy_request'", [org]))).toBe(notices);
  });

  it("rate limits: 3 tries per sender in 10 minutes and 10 a day (honeypot included), 60 views per sender; buckets only, no hash kept", async () => {
    await resetCounts();
    for (let i = 0; i < 3; i += 1) expect((await submit(token, PAYLOAD, HASH_A, i % 2 === 0)).status).toBe("received");
    expect(await submit(token, PAYLOAD, HASH_A)).toEqual({ rate_limited: true });
    // another sender, in another of the business's 1,024 buckets (keyed by the random org id), is not refused
    const bucketOf = (hash: string) =>
      asAdmin(
        async (q) =>
          (await q<{ b: number }>("select (((hashtextextended(app.privacy_request_sender($1, $2), 0) % 1024) + 1024) % 1024)::int as b", [org, hash]))
            .rows[0].b,
      );
    const bucketA = await bucketOf(HASH_A);
    let hashB = HASH_B;
    for (let i = 0; (await bucketOf(hashB)) === bucketA; i++) hashB = (i.toString(16) + HASH_B).slice(0, 64);
    expect(await submit(token, PAYLOAD, hashB)).toEqual({ status: "received" });
    // the day's cap: after 10 tries in a day the sender waits, even when each 10-minute window was kept
    await resetCounts();
    for (let round = 0; round < 4; round += 1) {
      await asAdmin((q) => q("update app.privacy_request_counts set window_start = now() - interval '1 hour' where kind = 'submit'"));
      for (let i = 0; i < 3 && round * 3 + i < 10; i += 1) expect((await submit(token, PAYLOAD, HASH_A, true)).status).toBe("received");
    }
    await asAdmin((q) => q("update app.privacy_request_counts set window_start = now() - interval '1 hour' where kind = 'submit'"));
    expect(await submit(token, PAYLOAD, HASH_A)).toEqual({ rate_limited: true });
    // a refused sender does not count toward the link's day
    const linkCount = await asAdmin(async (q) => (await q<{ n: number }>("select submit_count as n from app.privacy_request_links where organization_id = $1", [org])).rows[0].n);
    expect(linkCount).toBe(0);
    await resetCounts();
    for (let i = 0; i < 60; i += 1) expect((await page(token, HASH_A)).business).toBeDefined();
    expect(await page(token, HASH_A)).toEqual({ rate_limited: true });
    expect((await page(token, hashB)).business).toBeDefined();
    const kept = await asAdmin(async (q) => (await q<{ t: string }>("select row_to_json(c)::text as t from app.privacy_request_counts c")).rows.map((r) => r.t).join(" "));
    expect(kept).not.toContain(HASH_A);
    expect(kept).not.toContain(hashB);
  });

  it("after 5 requests in a business's day, one notice counts the rest", async () => {
    await resetCounts();
    const notices = (entity: string) =>
      asAdmin(async (q) => (await q<{ body: string }>("select body from public.notifications where organization_id = $1 and entity_type = $2 and user_id = $3", [org, entity, owner.id])).rows);
    const before = (await notices("privacy_request")).length;
    const hashes = ["1", "2", "3", "4", "5", "6", "7"].map((c) => c.repeat(64));
    for (const h of hashes) expect((await submit(token, PAYLOAD, h)).status).toBe("received");
    expect((await notices("privacy_request")).length).toBe(before + 5);
    const extra = await notices("privacy_requests");
    expect(extra).toHaveLength(1);
    expect(extra[0].body).toBe("עוד 2 בקשות התקבלו היום. כל הבקשות ברשימת בקשות הפרטיות.");
    await resetCounts();
  });

  it("50 stored requests per link a day", async () => {
    await resetCounts();
    await asAdmin((q) => q("update app.privacy_request_links set submit_window_start = now(), submit_count = 50 where organization_id = $1", [org]));
    expect(await submit(token, PAYLOAD, null)).toEqual({ rate_limited: true });
    await resetCounts();
  });

  it("a revoked link, or a business whose public pages are closed, is not found", async () => {
    const t = await asUser(other.id, async (q) => (await q<{ t: string }>("select public.privacy_request_link_create($1) as t", [otherOrg])).rows[0].t);
    // a new link replaces the old one
    expect((await pgError(page(otherToken))).code).toBe("P0002");
    otherToken = t;
    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [otherOrg]));
    try {
      expect((await pgError(page(otherToken))).code).toBe("P0002");
      expect((await pgError(submit(otherToken, PAYLOAD))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [otherOrg]));
    }
    expect(await asUser(other.id, async (q) => (await q<{ r: boolean }>("select public.privacy_request_link_revoke($1) as r", [otherOrg])).rows[0].r)).toBe(true);
    expect((await pgError(page(otherToken))).code).toBe("P0002");
  });

  it("only owners and admins read and handle requests; the officer mark adds no rights", async () => {
    const id = await newRequest(org, token);
    for (const u of [manager, officer, other]) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.privacy_requests where id = $1", [id])), u.id).toBe(0);
      expect(await asUser(u.id, async (q) => (await q("update public.privacy_requests set status = 'verifying' where id = $1", [id])).rowCount), u.id).toBe(0);
    }
    for (const u of [owner, admin]) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.privacy_requests where id = $1", [id])), u.id).toBe(1);
    }
    // no insert, no delete, no change to what the person sent
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.privacy_requests (organization_id, request_type, requester_name, contact_kind, contact_value, target_date) values ($1, 'access', 'x', 'email', 'a@b.co', current_date)", [org])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.privacy_requests where id = $1", [id])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.privacy_requests set requester_name = 'x' where id = $1", [id])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.privacy_requests set target_date = current_date + 90 where id = $1", [id])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.privacy_requests set verified_at = now() where id = $1", [id])))).code).toBe("42501");
  });

  it("the identity check comes before execution; it is marked once; closing freezes the request", async () => {
    const id = await newRequest(org, token);
    const err = (sql: string, params: unknown[] = [id]) => pgError(asUser(admin.id, (q) => q(sql, params)));
    expect((await err("update public.privacy_requests set status = 'in_progress' where id = $1")).hint).toBe("privacy_request:not_verified");
    expect((await err("update public.privacy_requests set status = 'done' where id = $1")).hint).toBe("privacy_request:not_verified");
    expect((await err("update public.privacy_requests set verify_note = 'x' where id = $1")).hint).toBe("privacy_request:verify_method");
    expect((await err("update public.privacy_requests set verify_method = 'dna' where id = $1")).code).toBe("23514");
    await asUser(admin.id, (q) => q("update public.privacy_requests set status = 'verifying', verify_method = 'id_document', verify_note = 'צילום תעודה' where id = $1", [id]));
    const row = (await requests(org)).find((r) => r.id === id)!;
    expect(row.verified_by).toBe(admin.id);
    expect(row.verified_at).not.toBeNull();
    expect((await err("update public.privacy_requests set verify_method = 'other' where id = $1")).hint).toBe("privacy_request:verified");
    expect((await err("update public.privacy_requests set refusal_reason = 'x' where id = $1")).hint).toBe("privacy_request:refusal_reason");
    await asUser(admin.id, (q) => q("update public.privacy_requests set status = 'done' where id = $1", [id]));
    const done = (await requests(org)).find((r) => r.id === id)!;
    expect(done.closed_by).toBe(admin.id);
    expect(done.closed_at).not.toBeNull();
    expect((await err("update public.privacy_requests set status = 'in_progress' where id = $1")).hint).toBe("privacy_request:closed");
  });

  it("a refusal needs a reason and needs no identity check", async () => {
    const id = await newRequest(org, token);
    expect((await pgError(asUser(owner.id, (q) => q("update public.privacy_requests set status = 'refused' where id = $1", [id])))).hint).toBe("privacy_request:refusal_reason");
    await asUser(owner.id, (q) => q("update public.privacy_requests set status = 'refused', refusal_reason = 'לא הצלחנו לאמת' where id = $1", [id]));
    expect((await requests(org)).find((r) => r.id === id)!.status).toBe("refused");
  });

  it("a link names one live record of the business; a read-only business still handles requests, a suspended one does not", async () => {
    const id = await newRequest(org, token);
    const lead = await insertLead(owner.id, org, { full_name: "דנה כהן" });
    const foreign = await insertLead(other.id, otherOrg, { full_name: "זר" });
    expect((await pgError(asUser(owner.id, (q) => q("update public.privacy_requests set lead_id = $2 where id = $1", [id, foreign])))).hint).toBe("privacy_request:link");
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
    expect((await pgError(asUser(owner.id, (q) => q("update public.privacy_requests set lead_id = $2 where id = $1", [id, lead])))).hint).toBe("privacy_request:link");
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = null where id = $1", [lead]));
    await asUser(owner.id, (q) => q("update public.privacy_requests set lead_id = $2 where id = $1", [id, lead]));
    const contact = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'x') returning id", [org])).rows[0].id);
    expect((await pgError(asUser(owner.id, (q) => q("update public.privacy_requests set contact_id = $2 where id = $1", [id, contact])))).code).toBe("23514");
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await asUser(owner.id, async (q) => (await q("update public.privacy_requests set status = 'verifying' where id = $1", [id])).rowCount)).toBe(1);
      await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [org]));
      expect(await asUser(owner.id, async (q) => (await q("update public.privacy_requests set status = 'new' where id = $1", [id])).rowCount)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("an unlinked or switched record keeps reaching the request, so its later erasure still empties it", async () => {
    const id = await newRequest(org, token);
    const first = await insertLead(owner.id, org, { full_name: "ראשון" });
    const contact = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'שני') returning id", [org])).rows[0].id);
    await asUser(owner.id, (q) => q("update public.privacy_requests set lead_id = $2 where id = $1", [id, first]));
    await asUser(owner.id, (q) => q("update public.privacy_requests set lead_id = null, contact_id = $2 where id = $1", [id, contact]));
    await asUser(owner.id, (q) => q("update public.privacy_requests set contact_id = null where id = $1", [id]));
    const row = (await requests(org)).find((r) => r.id === id)!;
    expect(row.former_lead_ids).toEqual([first]);
    expect(row.former_contact_ids).toEqual([contact]);
    // a person cannot write the kept history
    expect((await pgError(asUser(owner.id, (q) => q("update public.privacy_requests set former_lead_ids = '{}' where id = $1", [id])))).code).toBe("42501");
    // the first record's erasure reaches the request it was unlinked from; a person's own purge passes a closed request
    await asUser(owner.id, (q) => q("update public.privacy_requests set status = 'refused', refusal_reason = 'בקשה לא רצינית / ספאם' where id = $1", [id]));
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [first]));
    await asUser(owner.id, (q) => q("delete from public.leads where id = $1", [first]));
    await asAdmin((q) => q("select app.audit_erase_core($1, 'leads', $2, null)", [org, first]));
    const erased = (await requests(org)).find((r) => r.id === id)!;
    expect(erased.requester_name).toBeNull();
    expect(erased.erased_at).not.toBeNull();
    expect(erased.status).toBe("refused");
  });

  it("a merge moves the duplicate's requests to the kept record", async () => {
    const id = await newRequest(org, token);
    const keep = await insertLead(owner.id, org, { full_name: "שמור" });
    const dup = await insertLead(owner.id, org, { full_name: "כפול" });
    await asUser(owner.id, (q) => q("update public.privacy_requests set lead_id = $2 where id = $1", [id, dup]));
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep, dup]));
    expect((await requests(org)).find((r) => r.id === id)!.lead_id).toBe(keep);
  });

  it("a privacy erasure of the linked record empties the request's personal details and its history", async () => {
    const id = await newRequest(org, token, { ...PAYLOAD, request_type: "erasure", details: "נא למחוק" });
    const lead = await insertLead(owner.id, org, { full_name: "דנה כהן" });
    await asUser(owner.id, (q) => q("update public.privacy_requests set lead_id = $2, verify_method = 'known_details', verify_note = 'דנה ענתה נכון' where id = $1", [id, lead]));
    // a closed request does not stop the purge (the FK's set-null is a server write)
    await asUser(owner.id, (q) => q("update public.privacy_requests set status = 'done' where id = $1", [id]));
    // the purge keeps the old link for the erasure
    await asAdmin((q) => q("delete from public.leads where id = $1", [lead]));
    const purged = (await requests(org)).find((r) => r.id === id)!;
    expect(purged.lead_id).toBeNull();
    expect(purged.former_lead_ids).toEqual([lead]);
    expect(purged.requester_name).toBe("דנה כהן");
    await asAdmin((q) => q("select app.audit_erase_core($1, 'leads', $2, null)", [org, lead]));
    const erased = (await requests(org)).find((r) => r.id === id)!;
    expect(erased.requester_name).toBeNull();
    expect(erased.contact_value).toBeNull();
    expect(erased.details).toBeNull();
    expect(erased.verify_note).toBeNull();
    expect(erased.erased_at).not.toBeNull();
    expect(erased.request_type).toBe("erasure");
    const history = await asAdmin(async (q) => (await q<{ c: string }>("select changes::text as c from public.audit_log where entity_type = 'privacy_requests' and entity_id = $1", [id])).rows);
    expect(history.length).toBeGreaterThan(0);
    for (const h of history) expect(h.c).toBe('{"erased": true}');
    // other requests are untouched
    expect((await requests(org)).filter((r) => r.erased_at === null).length).toBeGreaterThan(0);
  });
});
