import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

describe("erasing a deleted record from the audit log", () => {
  let owner: U, rep: U, outsider: U;
  let org: string, form: string;

  beforeAll(async () => {
    owner = await createUser("erase-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member");
    outsider = await createUser("erase-outsider");
    await createOrg(outsider.id);
    form = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס') returning id", [org])).rows[0].id);
  });

  /** A lead with a change, a task of its own, a form submission; trashed and purged by the owner. */
  async function purgedLead(name: string, email: string, phone: string): Promise<{ lead: string; task: string; submission: string }> {
    const lead = await insertLead(rep.id, org, { full_name: name, email, phone });
    await asUser(rep.id, (q) => q("update public.leads set job_title = 'מנהלת' where id = $1", [lead]));
    const task = await asUser(rep.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, lead_id) values ($1, $2, $3) returning id", [org, `להתקשר ל${name}`, lead])).rows[0].id,
    );
    const submission = await asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, user_agent) values ($1, $2, 'accepted', $3, $4, 'Mozilla') returning id",
          [org, form, lead, JSON.stringify({ name, email, phone })],
        )
      ).rows[0].id,
    );
    await asUser(owner.id, async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [lead]);
      await q("delete from public.leads where id = $1", [lead]);
    });
    return { lead, task, submission };
  }

  const auditText = (ids: string[]) =>
    asAdmin(async (q) => (await q<{ t: string }>("select string_agg(changes::text, ' ') as t from public.audit_log where entity_id = any ($1)", [ids])).rows[0].t ?? "");

  it("purging a lead empties its form submissions", async () => {
    const { submission } = await purgedLead("נועה כהן", "noa@example.test", "0501234567");
    const row = await asAdmin(async (q) => (await q<{ payload: unknown; user_agent: string | null }>("select payload, user_agent from public.form_submissions where id = $1", [submission])).rows[0]);
    expect(row).toEqual({ payload: {}, user_agent: null });
  });

  it("admins find the deleted record by name, phone or email; others find nothing", async () => {
    const { lead } = await purgedLead("דניאל לוי", "daniel@example.test", "0527654321");
    for (const query of ["דניאל", "0527654321", "DANIEL@example"]) {
      const found = await asUser(owner.id, async (q) => (await q<{ r: Array<{ entity_id: string; name: string }> }>("select public.audit_erase_candidates($1, $2) as r", [org, query])).rows[0].r);
      expect(found.map((f) => f.entity_id)).toContain(lead);
    }
    const asRep = await asUser(rep.id, async (q) => (await q<{ r: unknown[] }>("select public.audit_erase_candidates($1, 'דניאל') as r", [org])).rows[0].r);
    expect(asRep).toEqual([]);
    // wildcards are taken literally
    const wild = await asUser(owner.id, async (q) => (await q<{ r: unknown[] }>("select public.audit_erase_candidates($1, '%%') as r", [org])).rows[0].r);
    expect(wild).toEqual([]);
  });

  it("erases the record's entries and its tasks' entries, keeps who and when, and logs the erasure", async () => {
    const { lead, task } = await purgedLead("רותם אברהם", "rotem@example.test", "0541112222");
    const before = await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = any ($1)", [[lead, task]]));
    expect(await auditText([lead, task])).toContain("רותם");

    const erased = await asUser(owner.id, async (q) => (await q<{ n: number }>("select public.audit_erase_record($1, 'leads', $2) as n", [org, lead])).rows[0].n);
    expect(erased).toBeGreaterThanOrEqual(4);
    expect(await auditText([lead, task])).not.toMatch(/רותם|rotem|0541112222|מנהלת/);
    // the entries stay (plus one for the erasure)
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = any ($1)", [[lead, task]]))).toBe(before + 1);
    const log = await asAdmin(async (q) => (await q<{ actor_id: string; changes: unknown }>("select actor_id, changes from public.audit_log where entity_id = $1 and action = 'erase'", [lead])).rows);
    expect(log).toEqual([{ actor_id: owner.id, changes: { entries: erased } }]);
    // nothing left to find
    const found = await asUser(owner.id, async (q) => (await q<{ r: unknown[] }>("select public.audit_erase_candidates($1, 'רותם') as r", [org])).rows[0].r);
    expect(found).toEqual([]);
  });

  it("empties the merge copy on the kept record", async () => {
    const keep = await insertLead(owner.id, org, { full_name: "יעל מזרחי", email: "yael@example.test" });
    const dup = await insertLead(owner.id, org, { full_name: "יעל מזרחי כפול", phone: "0539998888" });
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep, dup]));
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'leads', $2)", [org, dup]));
    const activity = await asAdmin(async (q) => (await q<{ body: string; metadata: Record<string, unknown> }>("select body, metadata from public.activities where lead_id = $1 and metadata ? 'merged_id'", [keep])).rows[0]);
    expect(activity.metadata).toEqual({ merged_id: dup });
    expect(activity.body).not.toContain("יעל");
  });

  it("form submissions already unlinked are emptied by email or phone", async () => {
    const lead = await insertLead(rep.id, org, { full_name: "אורי", email: "uri@example.test", phone: "0587776666" });
    const old = await asAdmin(async (q) => {
      const id = (
        await q<{ id: string }>(
          "insert into public.form_submissions (organization_id, form_id, status, lead_id, payload) values ($1, $2, 'duplicate', null, $3) returning id",
          [org, form, JSON.stringify({ phone: "0587776666", message: "שלום" })],
        )
      ).rows[0].id;
      const other = (
        await q<{ id: string }>("insert into public.form_submissions (organization_id, form_id, status, payload) values ($1, $2, 'spam', '{\"phone\": \"0500000000\"}') returning id", [org, form])
      ).rows[0].id;
      return [id, other];
    });
    await asUser(owner.id, async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [lead]);
      await q("delete from public.leads where id = $1", [lead]);
      await q("select public.audit_erase_record($1, 'leads', $2)", [org, lead]);
    });
    const payloads = await asAdmin(async (q) => (await q<{ id: string; payload: unknown }>("select id, payload from public.form_submissions where id = any ($1) order by id", [old])).rows);
    expect(payloads.find((p) => p.id === old[0])?.payload).toEqual({});
    expect(payloads.find((p) => p.id === old[1])?.payload).toEqual({ phone: "0500000000" });
  });

  it("refuses a record that still exists, non-admins and other organizations", async () => {
    const live = await insertLead(rep.id, org, { full_name: "עדיין כאן" });
    expect((await pgError(asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'leads', $2)", [org, live])))).hint).toBe("erase:exists");
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [live]));
    expect((await pgError(asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'leads', $2)", [org, live])))).hint).toBe("erase:exists");

    const { lead } = await purgedLead("שחר", "shahar@example.test", "0561234567");
    expect((await pgError(asUser(rep.id, (q) => q("select public.audit_erase_record($1, 'leads', $2)", [org, lead])))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("select public.audit_erase_record($1, 'leads', $2)", [org, lead])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'tasks', $2)", [org, lead])))).code).toBe("22023");
    expect(await auditText([lead])).toContain("שחר");
  });
});
