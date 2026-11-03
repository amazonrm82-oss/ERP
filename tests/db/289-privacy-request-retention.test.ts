import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type Row = Record<string, unknown> & { id: string };

/**
 * PRK-02 retention (owner, 3 November 2026, answer (76) א): a request's personal details are emptied 12 months after it was
 * closed, and a request never closed 12 months after it was received. An update, never a delete: the row stays as the log, and
 * the request's own audit entries are erased like a privacy erasure does. Time is simulated by moving closed_at / received_at
 * back as the superuser.
 */
describe("privacy request retention (PRK-02, (76) א)", () => {
  let owner: { id: string };
  let org: string;
  let token: string;
  let hashSeq = 0;

  const requests = () =>
    asAdmin(async (q) => (await q<Row>("select * from public.privacy_requests where organization_id = $1 order by received_at, id", [org])).rows);
  const byId = async (id: string) => (await requests()).find((r) => r.id === id)!;
  const run = (limit?: number) =>
    asAdmin(async (q) =>
      limit === undefined
        ? (await q<{ n: number }>("select app.run_privacy_request_retention() as n")).rows[0].n
        : (await q<{ n: number }>("select app.run_privacy_request_retention($1) as n", [limit])).rows[0].n,
    );
  const newRequest = async (details = "מה שמור עליי?") => {
    await asAdmin(async (q) => {
      await q("update app.privacy_request_counts set window_start = now() - interval '2 days'");
      await q("update app.privacy_request_links set view_window_start = null, view_count = 0, submit_window_start = null, submit_count = 0");
    });
    hashSeq += 1;
    const hash = hashSeq.toString(16).padStart(64, "0");
    const payload = { request_type: "access", name: "דנה כהן", contact_kind: "email", contact_value: "dana@example.com", details };
    await asService((q) => q("select public.privacy_request_submit($1, $2, $3, false)", [token, JSON.stringify(payload), hash]));
    const rows = await requests();
    return rows[rows.length - 1].id;
  };
  const shift = (id: string, column: "received_at" | "closed_at", interval: string) =>
    asAdmin((q) => q(`update public.privacy_requests set ${column} = ${column} - $2::interval where id = $1`, [id, interval]));
  const history = (id: string) =>
    asAdmin(async (q) => (await q<{ c: string }>("select changes::text as c from public.audit_log where entity_type = 'privacy_requests' and entity_id = $1", [id])).rows.map((r) => r.c));

  beforeAll(async () => {
    owner = await createUser("prkret-owner");
    org = await createOrg(owner.id, "עסק השמירה");
    token = await asUser(owner.id, async (q) => (await q<{ t: string }>("select public.privacy_request_link_create($1) as t", [org])).rows[0].t);
  });

  it("no API role may run the job", async () => {
    for (const role of ["authenticated", "service_role", "anon"]) {
      const allowed = await asAdmin(async (q) =>
        (await q<{ ok: boolean }>("select has_function_privilege($1, 'app.run_privacy_request_retention(integer)', 'execute') as ok", [role])).rows[0].ok,
      );
      expect(allowed, role).toBe(false);
    }
    expect((await pgError(asUser(owner.id, (q) => q("select app.run_privacy_request_retention()")))).code).toBe("42501");
    // the flag is server only
    const id = await newRequest();
    expect((await pgError(asUser(owner.id, (q) => q("update public.privacy_requests set erased_by_retention = true where id = $1", [id]))))).toMatchObject({ code: "42501" });
  });

  it("an open request is emptied 12 months after it was received, not a day before", async () => {
    const id = await newRequest();
    await shift(id, "received_at", "12 months - 1 day");
    await run();
    expect((await byId(id)).requester_name).toBe("דנה כהן");
    expect((await byId(id)).erased_at).toBeNull();

    await shift(id, "received_at", "2 days");
    await run();
    const row = await byId(id);
    expect(row.requester_name).toBeNull();
    expect(row.contact_value).toBeNull();
    expect(row.details).toBeNull();
    expect(row.erased_at).not.toBeNull();
    expect(row.erased_by_retention).toBe(true);
    // the log stays
    expect(row.request_type).toBe("access");
    expect(row.status).toBe("new");
    expect(row.contact_kind).toBe("email");
  });

  it("a closed request counts from its closing, and its notes, reason and history are erased", async () => {
    const id = await newRequest("נא לבדוק");
    await asUser(owner.id, (q) => q("update public.privacy_requests set verify_method = 'known_details', verify_note = 'ענתה נכון' where id = $1", [id]));
    await asUser(owner.id, (q) => q("update public.privacy_requests set status = 'refused', refusal_reason = 'בקשה לא רצינית / ספאם' where id = $1", [id]));
    // received long ago, closed recently: kept
    await shift(id, "received_at", "3 years");
    await shift(id, "closed_at", "11 months");
    await run();
    expect((await byId(id)).verify_note).toBe("ענתה נכון");
    expect((await history(id)).some((c) => c.includes("ענתה נכון"))).toBe(true);

    await shift(id, "closed_at", "2 months");
    await run();
    const row = await byId(id);
    expect(row.requester_name).toBeNull();
    expect(row.verify_note).toBeNull();
    expect(row.refusal_reason).toBe("הסיבה נמחקה (מדיניות שמירה)");
    expect(row.status).toBe("refused");
    expect(row.verify_method).toBe("known_details");
    expect(row.closed_at).not.toBeNull();
    const entries = await history(id);
    expect(entries.length).toBeGreaterThan(0);
    for (const c of entries) expect(c).toBe('{"erased": true}');
  });

  it("a request a privacy erasure emptied is not touched again; other businesses' and fresh requests stay", async () => {
    const id = await newRequest();
    const fresh = await newRequest();
    const lead = await insertLead(owner.id, org, { full_name: "דנה כהן" });
    await asUser(owner.id, (q) => q("update public.privacy_requests set lead_id = $2 where id = $1", [id, lead]));
    await asAdmin((q) => q("delete from public.leads where id = $1", [lead]));
    await asAdmin((q) => q("select app.audit_erase_core($1, 'leads', $2, null)", [org, lead]));
    const before = await byId(id);
    expect(before.erased_at).not.toBeNull();
    expect(before.erased_by_retention).toBe(false);
    await shift(id, "received_at", "2 years");
    await run();
    const after = await byId(id);
    expect(after.erased_by_retention).toBe(false);
    expect(String(after.erased_at)).toBe(String(before.erased_at));
    expect((await byId(fresh)).requester_name).toBe("דנה כהן");
  });

  it("works in batches: the limit caps one run, the next run takes the rest", async () => {
    const ids = [await newRequest(), await newRequest(), await newRequest()];
    for (const id of ids) await shift(id, "received_at", "13 months");
    expect(await run(2)).toBe(2);
    expect((await requests()).filter((r) => ids.includes(r.id) && r.erased_at !== null)).toHaveLength(2);
    expect(await run()).toBe(1);
    expect((await requests()).filter((r) => ids.includes(r.id) && r.erased_at !== null)).toHaveLength(3);
    expect(await run()).toBe(0);
    expect(await run(0)).toBe(0);
  });
});
