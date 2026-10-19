import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";
import { staleRestores } from "./rerun";

afterAll(closePool);

type U = { id: string; email: string };
type Row = { record_type: string; record_id: string; removable: boolean };

const TABLE: Record<string, string> = { lead: "leads", contact: "contacts", company: "companies", deal: "deals", task: "tasks" };

// one sample record by what it is (they are all created in one transaction, so their order is not fixed)
const sampleId = (orgId: string, table: string, where: string) =>
  asAdmin(async (q) => (await q<{ id: string }>(`select id from public.${table} where organization_id = $1 and ${where}`, [orgId])).rows[0].id);

// USR-04: the setup checklist can be closed; sample data is added in one call and noted in app.sample_records.
describe("setup checklist and sample data (USR-04)", () => {
  let owner: U, admin: U, manager: U, member: U, outsider: U;
  let org: string, otherOrg: string;

  const add = (userId: string, orgId: string) => asUser(userId, (q) => q<{ r: { created: number } }>("select public.sample_data_add($1) as r", [orgId]));
  const records = (userId: string, orgId: string) =>
    asUser(userId, async (q) => (await q<Row>("select * from public.sample_data_records($1)", [orgId])).rows);

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    manager = await addMember(org, owner.id, "manager");
    member = await addMember(org, owner.id, "member");
    outsider = await createUser("outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  describe("closing the checklist", () => {
    const hidden = (id: string) =>
      asAdmin(async (q) => (await q<{ h: string | null }>("select setup_checklist_hidden_at as h from public.organizations where id = $1", [id])).rows[0].h);
    const hide = (userId: string, id: string, value: string | null) =>
      asUser(userId, (q) => q("update public.organizations set setup_checklist_hidden_at = $2 where id = $1 returning id", [id, value]));

    it("starts shown; owners and admins close and reopen it", async () => {
      expect(await hidden(org)).toBeNull();
      expect((await hide(owner.id, org, new Date().toISOString())).rowCount).toBe(1);
      expect(await hidden(org)).not.toBeNull();
      expect((await hide(admin.id, org, null)).rowCount).toBe(1);
      expect(await hidden(org)).toBeNull();
    });

    it("a manager, a member, another business and anon cannot", async () => {
      const now = new Date().toISOString();
      expect((await hide(manager.id, org, now)).rowCount).toBe(0);
      expect((await hide(member.id, org, now)).rowCount).toBe(0);
      expect((await hide(outsider.id, org, now)).rowCount).toBe(0);
      expect(await hidden(org)).toBeNull();
      // without WHERE: only the caller's own business
      await asUser(outsider.id, (q) => q("update public.organizations set setup_checklist_hidden_at = now()"));
      expect(await hidden(org)).toBeNull();
      expect(await hidden(otherOrg)).not.toBeNull();
      const err = await pgError(asAnon((q) => q("update public.organizations set setup_checklist_hidden_at = now() where id = $1", [org])));
      expect(err.code).toBe("42501");
    });
  });

  describe("sample data", () => {
    it("only owners and admins of the business may add or list it; anon may not call it", async () => {
      for (const u of [manager, member, outsider]) {
        expect((await pgError(add(u.id, org))).code).toBe("42501");
        expect((await pgError(records(u.id, org))).code).toBe("42501");
      }
      expect((await pgError(asAnon((q) => q("select public.sample_data_add($1)", [org])))).code).toBe("42501");
      expect((await pgError(asAnon((q) => q("select * from public.sample_data_records($1)", [org])))).code).toBe("42501");
      expect(await records(owner.id, org)).toEqual([]);
    });

    it("adds a company, two contacts, three leads, a deal and two tasks, named and tagged as sample data", async () => {
      const res = await add(owner.id, org);
      expect(res.rows[0].r.created).toBe(9);
      const rows = await records(admin.id, org);
      const byType = (t: string) => rows.filter((r) => r.record_type === t).map((r) => r.record_id);
      expect(byType("company")).toHaveLength(1);
      expect(byType("contact")).toHaveLength(2);
      expect(byType("lead")).toHaveLength(3);
      expect(byType("deal")).toHaveLength(1);
      expect(byType("task")).toHaveLength(2);

      await asAdmin(async (q) => {
        const tag = (await q<{ id: string }>("select id from public.tags where organization_id = $1 and name = 'דוגמה'", [org])).rows[0].id;
        for (const r of rows) {
          const table = TABLE[r.record_type];
          const nameCol = table === "leads" ? "full_name" : table === "contacts" ? "full_name" : table === "tasks" ? "title" : "name";
          const row = (
            await q<{ n: string; owner_id: string; org: string }>(
              `select ${nameCol} as n, owner_id, organization_id as org from public.${table} where id = $1`,
              [r.record_id],
            )
          ).rows[0];
          expect(row.org).toBe(org);
          expect(row.n.endsWith("(דוגמה)")).toBe(true);
          expect(row.owner_id).toBe(owner.id);
          if (table !== "tasks") {
            expect(await count(q, `select 1 from public.${table} where id = $1 and $2 = any (tag_ids)`, [r.record_id, tag])).toBe(1);
          }
        }
        // automations do not react, and nobody is notified
        const ids = rows.map((r) => r.record_id);
        expect(await count(q, "select 1 from public.outbox_events where entity_id = any ($1) and coalesce(payload ->> 'origin', '') <> 'automation'", [ids])).toBe(0);
        expect(await count(q, "select 1 from public.notifications where entity_id = any ($1)", [ids])).toBe(0);
      });
    });

    it("cannot be added twice while it is there", async () => {
      const err = await pgError(add(admin.id, org));
      expect(err.code).toBe("P0001");
      expect(err.hint).toBe("sample:exists");
    });

    it("a read-only business cannot add it", async () => {
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [otherOrg]));
      expect((await pgError(add(outsider.id, otherOrg))).code).toBe("42501");
      await asAdmin((q) => q("update public.organizations set status = 'trial' where id = $1", [otherOrg]));
    });

    it("a real record tagged 'דוגמה' is not sample data", async () => {
      const real = await insertLead(owner.id, org, { full_name: "לקוח אמיתי" });
      await asUser(owner.id, (q) =>
        q("update public.leads set tag_ids = array(select id from public.tags where organization_id = $1 and name = 'דוגמה') where id = $2", [org, real]),
      );
      expect((await records(owner.id, org)).map((r) => r.record_id)).not.toContain(real);
    });

    it("one call removes it all, notes included; the real records stay", async () => {
      const rows = await records(owner.id, org);
      const res = await asUser(owner.id, (q) => q<{ r: { removed: number; kept: number } }>("select public.sample_data_remove($1) as r", [org]));
      expect(res.rows[0].r).toEqual({ removed: 9, kept: 0 });
      expect(await records(owner.id, org)).toEqual([]);
      await asAdmin(async (q) => {
        for (const r of rows) {
          expect(await count(q, `select 1 from public.${TABLE[r.record_type]} where id = $1`, [r.record_id])).toBe(0);
        }
        // the real lead stays
        expect(await count(q, "select 1 from public.leads where organization_id = $1 and full_name = 'לקוח אמיתי'", [org])).toBe(1);
      });
      // and it can be added again
      expect((await add(owner.id, org)).rows[0].r.created).toBe(9);
    });

    it("only owners and admins of a writable business may remove it", async () => {
      for (const u of [manager, member, outsider]) {
        expect((await pgError(asUser(u.id, (q) => q("select public.sample_data_remove($1)", [org])))).code).toBe("42501");
      }
      expect((await pgError(asAnon((q) => q("select public.sample_data_remove($1)", [org])))).code).toBe("42501");
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
      expect((await pgError(asUser(owner.id, (q) => q("select public.sample_data_remove($1)", [org])))).code).toBe("42501");
      await asAdmin((q) => q("update public.organizations set status = 'trial' where id = $1", [org]));
      expect(await records(owner.id, org)).toHaveLength(9);
    });

    it("stays inside the business: another business gets its own and does not see these", async () => {
      expect((await add(outsider.id, otherOrg)).rows[0].r.created).toBe(9);
      const mine = (await records(owner.id, org)).map((r) => r.record_id);
      const theirs = (await records(outsider.id, otherOrg)).map((r) => r.record_id);
      expect(mine.filter((id) => theirs.includes(id))).toEqual([]);
      expect((await pgError(records(outsider.id, org))).code).toBe("42501");
    });

    it("clients cannot touch app.sample_records directly", async () => {
      const err = await pgError(asUser(owner.id, (q) => q("select * from app.sample_records")));
      expect(err.code).toBe("42501");
    });

    it("a plan limit still applies (the whole set or nothing)", async () => {
      const third = await createUser("third");
      const org3 = await createOrg(third.id, "עסק שלישי");
      await asAdmin((q) => q(`update public.subscriptions set limit_overrides = '{"max_records": 2}'::jsonb where organization_id = $1`, [org3]));
      const err = await pgError(add(third.id, org3));
      expect(err.hint).toBe("limit:max_records");
      expect(await records(third.id, org3)).toEqual([]);
    });
  });

  describe("only untouched sample records are removable", () => {
    let o: U, org4: string;
    let rows: Row[];
    const ids = (type: string) => rows.filter((r) => r.record_type === type).map((r) => r.record_id);
    const removable = async () => new Map((await records(o.id, org4)).map((r) => [r.record_id, r.removable]));

    beforeAll(async () => {
      o = await createUser("owner4");
      org4 = await createOrg(o.id, "עסק רביעי");
      await add(o.id, org4);
      rows = await records(o.id, org4);
    });

    it("all start removable; moving one to the recycle bin keeps it removable", async () => {
      expect(rows.every((r) => r.removable)).toBe(true);
      const lead = ids("lead")[2];
      await asUser(o.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
      expect((await removable()).get(lead)).toBe(true);
      await asUser(o.id, (q) => q("update public.leads set deleted_at = null where id = $1", [lead]));
    });

    it("a real lead merged into a sample lead keeps that lead (not removable)", async () => {
      const real = await insertLead(o.id, org4, { full_name: "לקוחה אמיתית", email: "real@example.com" });
      const keep = ids("lead")[0];
      await asUser(o.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}'::jsonb)", [org4, keep, real]));
      expect((await removable()).get(keep)).toBe(false);
    });

    it("an edited sample contact is not removable", async () => {
      const contact = await sampleId(org4, "contacts", "company_id is null");
      await asUser(o.id, (q) => q("update public.contacts set job_title = 'מנהל רכש' where id = $1", [contact]));
      expect((await removable()).get(contact)).toBe(false);
    });

    it("a sample deal with a note is not removable", async () => {
      const deal = ids("deal")[0];
      await asUser(o.id, (q) => q("insert into public.activities (organization_id, type, body, deal_id) values ($1, 'note', 'שיחה עם הלקוח', $2)", [org4, deal]));
      expect((await removable()).get(deal)).toBe(false);
    });

    it("a sample lead with a real task is not removable", async () => {
      const lead = ids("lead")[1];
      await asUser(o.id, (q) => q("insert into public.tasks (organization_id, title, lead_id) values ($1, 'משימה אמיתית', $2)", [org4, lead]));
      expect((await removable()).get(lead)).toBe(false);
    });

    it("the untouched ones stay removable, and a new set can be added while only changed ones are left", async () => {
      const map = await removable();
      expect(map.get(ids("lead")[2])).toBe(true);
      // the deal is kept (it has a note), so the contact and the company it points at are kept too
      expect(map.get(await sampleId(org4, "contacts", "company_id is not null"))).toBe(false);
      expect(map.get(ids("company")[0])).toBe(false);
      expect(ids("task").every((id) => map.get(id))).toBe(true);
      expect((await pgError(add(o.id, org4))).hint).toBe("sample:exists");
    });
  });

  describe("removal keeps what someone changed", () => {
    const remove = (userId: string, orgId: string) =>
      asUser(userId, async (q) => (await q<{ r: { removed: number; kept: number } }>("select public.sample_data_remove($1) as r", [orgId])).rows[0].r);
    const fresh = async (label: string) => {
      const o = await createUser(label);
      const id = await createOrg(o.id, `עסק ${label}`);
      await add(o.id, id);
      const rows = await records(o.id, id);
      return { o, id, ids: (type: string) => rows.filter((r) => r.record_type === type).map((r) => r.record_id) };
    };
    const exists = (table: string, id: string) => asAdmin((q) => count(q, `select 1 from public.${table} where id = $1`, [id]));

    it("edited sample tasks stay, and so do the lead and the deal they belong to", async () => {
      const { o, id, ids } = await fresh("t1");
      const task1 = await sampleId(id, "tasks", "lead_id is not null");
      const task2 = await sampleId(id, "tasks", "deal_id is not null");
      const lead1 = await sampleId(id, "leads", "full_name like 'דנה%'");
      const otherLead = await sampleId(id, "leads", "full_name like 'מיכל%'");
      await asUser(o.id, (q) => q("update public.tasks set title = 'להתקשר למשה', description = 'פרטים אמיתיים' where id = $1", [task1]));
      await asUser(o.id, (q) => q("update public.tasks set status = 'done', completed_at = now(), outcome = 'נסגר' where id = $1", [task2]));
      const result = await remove(o.id, id);
      expect(await exists("tasks", task1)).toBe(1);
      expect(await exists("tasks", task2)).toBe(1);
      expect(await exists("leads", lead1)).toBe(1);
      expect(await exists("deals", ids("deal")[0])).toBe(1);
      expect(result.kept).toBeGreaterThanOrEqual(4);
      expect(await exists("leads", otherLead)).toBe(0);
    });

    it("an edited sample deal and contact keep their contact and company", async () => {
      const { o, id, ids } = await fresh("t2");
      const deal = ids("deal")[0];
      const withCompany = await sampleId(id, "contacts", "company_id is not null");
      const withoutCompany = await sampleId(id, "contacts", "company_id is null");
      await asUser(o.id, (q) => q("update public.deals set amount_agorot = 9900000, name = 'עסקה אמיתית' where id = $1", [deal]));
      await asUser(o.id, (q) => q("update public.contacts set first_name = 'לקוח אמיתי' where id = $1", [withCompany]));
      await remove(o.id, id);
      const after = await asAdmin(async (q) => ({
        deal: (await q<{ contact_id: string | null; company_id: string | null }>("select contact_id, company_id from public.deals where id = $1", [deal])).rows[0],
        contact: (await q<{ company_id: string | null }>("select company_id from public.contacts where id = $1", [withCompany])).rows[0],
      }));
      expect(after.deal.contact_id).toBe(withCompany);
      expect(after.deal.company_id).toBe(ids("company")[0]);
      expect(after.contact.company_id).toBe(ids("company")[0]);
      // the untouched second contact is gone
      expect(await exists("contacts", withoutCompany)).toBe(0);
    });

    it("a note on the sample deal keeps the deal, its contact and its company, links intact", async () => {
      const { o, id, ids } = await fresh("t5");
      const deal = ids("deal")[0];
      const contact = await sampleId(id, "contacts", "company_id is not null");
      const company = ids("company")[0];
      await asUser(o.id, (q) => q("insert into public.activities (organization_id, type, body, deal_id) values ($1, 'note', 'סיכום פגישה', $2)", [id, deal]));
      await remove(o.id, id);
      const after = await asAdmin(async (q) => ({
        deal: (await q<{ contact_id: string | null; company_id: string | null }>("select contact_id, company_id from public.deals where id = $1", [deal])).rows[0],
        contact: (await q<{ company_id: string | null }>("select company_id from public.contacts where id = $1", [contact])).rows[0],
      }));
      expect(after.deal).toEqual({ contact_id: contact, company_id: company });
      expect(after.contact.company_id).toBe(company);
      expect(await exists("companies", company)).toBe(1);
      expect(await asAdmin((q) => count(q, "select 1 from public.activities where deal_id = $1", [deal]))).toBe(1);
    });

    it("a real task on a sample contact keeps the contact and its company, link intact", async () => {
      const { o, id, ids } = await fresh("t6");
      const contact = await sampleId(id, "contacts", "company_id is not null");
      const company = ids("company")[0];
      await asUser(o.id, (q) => q("insert into public.tasks (organization_id, title, contact_id) values ($1, 'לחזור ללקוח', $2)", [id, contact]));
      await remove(o.id, id);
      const after = await asAdmin(async (q) => (await q<{ company_id: string | null }>("select company_id from public.contacts where id = $1", [contact])).rows[0]);
      expect(after.company_id).toBe(company);
      expect(await exists("companies", company)).toBe(1);
    });

    it("a sample contact with an added phone or email is real work: it stays, with its channel and its company", async () => {
      const { o, id, ids } = await fresh("t7");
      const contact = await sampleId(id, "contacts", "company_id is not null");
      const other = await sampleId(id, "contacts", "company_id is null");
      const company = ids("company")[0];
      // sample data itself adds no channels
      expect(await asAdmin((q) => count(q, "select 1 from public.contact_channels where organization_id = $1", [id]))).toBe(0);
      const channel = await asUser(o.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'phone', '050-1234567') returning id",
            [id, contact],
          )
        ).rows[0].id,
      );
      expect((await records(o.id, id)).find((r) => r.record_id === contact)?.removable).toBe(false);
      await remove(o.id, id);
      expect(await exists("contacts", contact)).toBe(1);
      expect(await exists("contact_channels", channel)).toBe(1);
      expect(await exists("companies", company)).toBe(1);
      // the untouched contact went
      expect(await exists("contacts", other)).toBe(0);
    });

    it("the snapshot does not depend on the session's time zone", async () => {
      const o = await createUser("tz");
      const id = await createOrg(o.id, "עסק אזור זמן");
      await asUser(o.id, async (q) => {
        await q("set local timezone = 'Asia/Jerusalem'");
        await q("select public.sample_data_add($1)", [id]);
      });
      const inJerusalem = await asUser(o.id, async (q) => {
        await q("set local timezone = 'Asia/Jerusalem'");
        return (await q<Row>("select * from public.sample_data_records($1)", [id])).rows;
      });
      const inTokyo = await asUser(o.id, async (q) => {
        await q("set local timezone = 'Asia/Tokyo'");
        return (await q<Row>("select * from public.sample_data_records($1)", [id])).rows;
      });
      expect(inJerusalem.filter((r) => r.removable)).toHaveLength(9);
      expect(inTokyo.filter((r) => r.removable)).toHaveLength(9);
    });

    it("a note written while the removal runs survives, and its record is kept", async () => {
      const { o, id } = await fresh("t3");
      const contact = await sampleId(id, "contacts", "company_id is null");
      let removal: Promise<{ removed: number; kept: number }> | undefined;
      // the colleague's transaction holds the note; the removal starts and waits for it
      await asUser(o.id, async (q) => {
        await q("insert into public.activities (organization_id, type, body, contact_id) values ($1, 'note', 'שיחה אמיתית', $2)", [id, contact]);
        removal = remove(o.id, id);
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      const result = await removal;
      expect(result?.kept).toBe(1);
      expect(await exists("contacts", contact)).toBe(1);
      expect(await asAdmin((q) => count(q, "select 1 from public.activities where contact_id = $1 and body = 'שיחה אמיתית'", [contact]))).toBe(1);
    });

    it("during a removal the guard refuses to delete a changed sample record; a person's own purge is not affected", async () => {
      const { o, id } = await fresh("t4");
      const contact = await sampleId(id, "contacts", "company_id is null");
      await asUser(o.id, (q) => q("update public.contacts set job_title = 'מנהל', deleted_at = now() where id = $1", [contact]));
      const err = await pgError(
        asUser(o.id, async (q) => {
          await q("select set_config('app.sample_removal', 'on', true)");
          await q("delete from public.contacts where id = $1", [contact]);
        }),
      );
      expect(err.hint).toBe("sample:changed");
      expect(await exists("contacts", contact)).toBe(1);
      const purged = await asUser(o.id, (q) => q("delete from public.contacts where id = $1 returning id", [contact]));
      expect(purged.rowCount).toBe(1);
    });
  });

  describe("activation (GAP-06) ignores sample leads", () => {
    const activated = (orgId: string) => asAdmin((q) => count(q, "select 1 from app.org_activation where organization_id = $1", [orgId]));
    const call = (userId: string, orgId: string, lead: string) =>
      asUser(userId, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה', $2)", [orgId, lead]));

    it("a call on a sample lead does not activate the business; a call on a real lead does", async () => {
      const o = await createUser("act-sample");
      const id = await createOrg(o.id, "עסק הפעלה");
      await add(o.id, id);
      const sampleLead = await sampleId(id, "leads", "full_name like 'דנה%'");
      await call(o.id, id, sampleLead);
      expect(await activated(id)).toBe(0);
      const real = await insertLead(o.id, id, { full_name: "לקוח אמיתי" });
      await call(o.id, id, real);
      expect(await activated(id)).toBe(1);
    });
  });

  it("two calls at the same time add one set", async () => {
    const o = await createUser("owner5");
    const org5 = await createOrg(o.id, "עסק חמישי");
    const results = await Promise.allSettled([add(o.id, org5), add(o.id, org5)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await records(o.id, org5)).toHaveLength(9);
  });

  it("running the migration again keeps every stored value", async () => {
    const before = await records(owner.id, org);
    const dir = path.resolve(__dirname, "../../supabase/migrations");
    // later ones redefine app.sample_row() (DEAL-03, TAX-06) and app.sample_untouched() (CNS-01, then DLI-01), so they
    // run again after the first, keeping the latest versions; deal_lines comes after consents_followups (both redefine
    // app.sample_untouched(), the later one wins); deal_lines revokes the table's client grants, so deal_line_billing
    // (DLI-04) runs after it to grant its column again
    const files = [
      "_setup_checklist.sql",
      "_sample_data_remove.sql",
      "_sample_data_followups.sql",
      "_deal_loss_reasons.sql",
      "_consents_followups.sql",
      "_money_currency.sql",
      "_deal_lines.sql",
      "_deal_line_billing.sql",
      // LEAD-05 redefines app.sample_row() last
      "_lead_score.sql",
      // lead_score also redefines app.audit_row(); PRM-01's later body (rule name) must stay the live one
      "_automation_permission_answer.sql",
      // automation_permission_answer redefines app.member_permission_built_keys(); PRM-04 adds 'view_costs' last
      "_product_costs.sql",
      // CON-05 redefines app.sample_untouched() last (links a person made keep the record), and with it
      // app.import_record_worked() of undo_own_import, which no file above touches
      "_contact_companies.sql",
      // CON-06 redefines app.sample_untouched() last (a relation keeps a sample contact), and with it
      // app.import_record_worked() and public.log_export(), whose latest bodies no file above puts back
      "_contact_relations.sql",
      // QUO-01 redefines app.sample_untouched(), app.import_record_worked() and app.merge_move_links() last
      "_quotes.sql",
      // SEG-01 redefines app.sample_untouched() last (a static segment keeps a sample lead or contact)
      "_segments.sql",
      // QUO-07 redefines app.quotes_check(), app.quotes_detach_contact() and app.audit_erase_core() of _quotes.sql last
      "_quote_send.sql",
      // RPT-01 redefines public.log_export() last (the 'products' report key)
      "_report_revenue_by_product.sql",
      // GAP-09 redefines public.quote_send() and app.audit_erase_core() of _quote_send.sql last
      "_quote_payment_schedule.sql",
      // TASK-06 redefines app.sample_untouched() last (steps keep a sample task)
      "_task_checklists.sql",
      // QUO-07 follow-ups redefine app.audit_erase_core() of _quote_payment_schedule.sql last
      "_quote_kept_followups.sql",
      // DLI-06 redefines public.log_export() last (the 'categories' and 'profit' report keys)
      "_report_categories_profit.sql",
      // QUO-12 redefines public.quote_public() of _quote_payment_schedule.sql last (a newer version on the old link)
      "_quote_versions.sql",
      // QUO-09 redefines public.quote_public() of _quote_versions.sql and app.audit_erase_core() of _quote_kept_followups.sql last
      "_quote_decisions.sql",
      // QUO-10 redefines public.quote_public() of _quote_versions.sql last (a customer's view is counted)
      "_quote_views.sql",
      // QUO-11 review redefines public.quote_public(), the decision functions and app.quotes_version_guard() last
      "_quote_superseded.sql",
      // QUO-17 redefines public.log_export() last (the 'quotes' report key)
      "_report_quotes.sql",
    ].map((suffix) => {
      const file = readdirSync(dir).find((f) => f.endsWith(suffix));
      expect(file, suffix).toBeDefined();
      return file as string;
    });
    // every function these files define must end at its latest body, or the teardown sees an old one; a newer
    // migration that redefines one of them is named here (add it to the list, in name order)
    expect(staleRestores(files, dir)).toEqual([]);
    for (const file of files) {
      await asAdmin((q) => q(readFileSync(path.join(dir, file), "utf8")));
    }
    expect(await records(owner.id, org)).toEqual(before);
  });
});
