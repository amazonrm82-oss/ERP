import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Item = Record<string, unknown>;
type Group = { count: number; items: Item[] };
type Suggestions = {
  allowed: true;
  since: string;
  duplicates: Group;
  unowned_leads: Group;
  no_channel: Group & { leads: number; contacts: number };
  rare_options: Group & { min_filled: number; max_used: number };
};

// DQL-03: public.cleanup_suggestions (invoker, RLS decides) and the weekly notice app.send_cleanup_suggestions.
describe("cleanup suggestions (DQL-03)", () => {
  let owner: U;
  let admin: U;
  let member: U;
  let manager: U;
  let viewer: U;
  let outsider: U;
  let org: string;
  const ids: Record<string, string> = {};

  const suggestions = (user: U, orgId = org, limit = 20): Promise<Suggestions> =>
    asUser(user.id, async (q) => (await q<{ r: Suggestions }>("select public.cleanup_suggestions($1, $2) as r", [orgId, limit])).rows[0].r);
  const backdate = (table: string, id: string, days: number) =>
    asAdmin(async (q) => {
      // app.touch_row keeps created_at: set it with the triggers off
      await q("set local session_replication_role = replica");
      await q(`update public.${table} set created_at = now() - make_interval(days => $2) where id = $1`, [id, days]);
      await q("set local session_replication_role = origin");
    });
  const contact = (fields: Record<string, unknown>) =>
    asUser(owner.id, async (q) => {
      const row = { organization_id: org, first_name: "איש", ...fields };
      const cols = Object.keys(row);
      return (
        await q<{ id: string }>(
          `insert into public.contacts (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          Object.values(row),
        )
      ).rows[0].id;
    });
  const company = (fields: Record<string, unknown>) =>
    asUser(owner.id, async (q) => {
      const row = { organization_id: org, ...fields };
      const cols = Object.keys(row);
      return (
        await q<{ id: string }>(
          `insert into public.companies (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          Object.values(row),
        )
      ).rows[0].id;
    });

  beforeAll(async () => {
    owner = await createUser("cln-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "cln-admin");
    member = await addMember(org, owner.id, "member", "cln-member");
    manager = await addMember(org, owner.id, "manager", "cln-manager");
    viewer = await addMember(org, owner.id, "viewer", "cln-viewer");
    outsider = await createUser("cln-outsider");
    await createOrg(outsider.id, "עסק אחר");

    // leads: an old one and a new one with the same phone; two new ones with the same email (the newer is the duplicate)
    ids.oldLead = await insertLead(owner.id, org, { full_name: "ישן", phone: "050-1234567", owner_id: owner.id });
    await backdate("leads", ids.oldLead, 60);
    ids.newLead = await insertLead(owner.id, org, { full_name: "חדש", phone: "0501234567", owner_id: owner.id });
    ids.mailA = await insertLead(owner.id, org, { full_name: "דואר א", email: "same@example.com", owner_id: owner.id });
    await backdate("leads", ids.mailA, 2);
    ids.mailB = await insertLead(owner.id, org, { full_name: "דואר ב", email: "SAME@example.com", owner_id: owner.id });
    // an old pair is not new: no suggestion
    ids.old1 = await insertLead(owner.id, org, { full_name: "ישן 1", email: "old@example.com", owner_id: owner.id });
    ids.old2 = await insertLead(owner.id, org, { full_name: "ישן 2", email: "old@example.com", owner_id: owner.id });
    await backdate("leads", ids.old1, 90);
    await backdate("leads", ids.old2, 80);

    // contacts: an old contact holds a further phone that a new contact has as its primary one
    ids.oldContact = await contact({ first_name: "ותיק", email: "vatik@example.com" });
    await asUser(owner.id, (q) =>
      q("insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'phone', '052-7654321')", [org, ids.oldContact]),
    );
    await backdate("contacts", ids.oldContact, 40);
    ids.newContact = await contact({ first_name: "חדשה", phone: "0527654321" });

    // companies: the same name, ignoring case and outer spaces
    ids.oldCompany = await company({ name: "Acme Ltd" });
    await backdate("companies", ids.oldCompany, 100);
    ids.newCompany = await company({ name: "  acme ltd " });

    // leads with no owner: an open one counts; a converted one does not
    ids.unowned = await insertLead(owner.id, org, { full_name: "בלי אחראי", phone: "053-1111111", owner_id: null });
    await asAdmin((q) => q("update public.leads set owner_id = null where id = $1", [ids.unowned]));

    // no phone and no email: a lead and a contact; a contact with only a further email is reachable
    ids.silentLead = await insertLead(owner.id, org, { full_name: "שקט", owner_id: owner.id });
    ids.silentContact = await contact({ first_name: "שקטה" });
    ids.reachable = await contact({ first_name: "עם ערוץ" });
    await asUser(owner.id, (q) =>
      q("insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'email', 'x@example.com')", [org, ids.reachable]),
    );
  });

  it("finds new duplicates by the duplicate rules, each new record once with its oldest match", async () => {
    const s = await suggestions(owner);
    const byId = new Map(s.duplicates.items.map((item) => [item.id as string, item]));
    expect(byId.get(ids.newLead)).toMatchObject({ type: "lead", other_id: ids.oldLead, match: "phone", name: "חדש", other_name: "ישן" });
    expect(byId.get(ids.mailB)).toMatchObject({ type: "lead", other_id: ids.mailA, match: "email" });
    expect(byId.has(ids.mailA)).toBe(false);
    expect(byId.has(ids.old2)).toBe(false);
    expect(byId.get(ids.newContact)).toMatchObject({ type: "contact", other_id: ids.oldContact, match: "phone" });
    expect(byId.get(ids.newCompany)).toMatchObject({ type: "company", other_id: ids.oldCompany, match: "name" });
    expect(s.duplicates.count).toBe(4);
  });

  it("counts open leads with no owner, and records with no phone and no email", async () => {
    const s = await suggestions(admin);
    expect(s.unowned_leads.items.map((i) => i.id)).toEqual([ids.unowned]);
    expect(s.unowned_leads.count).toBe(1);
    const silent = s.no_channel.items.map((i) => i.id);
    expect(silent).toEqual(expect.arrayContaining([ids.silentLead, ids.silentContact]));
    expect(silent).not.toContain(ids.reachable);
    // the old contact and the new company: a company is not judged here; the new contact has a phone
    expect(silent).not.toContain(ids.newContact);
    expect(s.no_channel.leads).toBe(1);
    expect(s.no_channel.count).toBe(s.no_channel.leads + s.no_channel.contacts);
  });

  it("a converted or binned lead leaves every group", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "לסל", owner_id: null });
    await asAdmin((q) => q("update public.leads set owner_id = null where id = $1", [lead]));
    expect((await suggestions(owner)).unowned_leads.count).toBe(2);
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
    const s = await suggestions(owner);
    expect(s.unowned_leads.count).toBe(1);
    expect(s.no_channel.items.map((i) => i.id)).not.toContain(lead);
  });

  it("names select options that fewer than 2 records hold, once 50 records have the field filled", async () => {
    await asUser(owner.id, (q) =>
      q(
        "insert into public.field_definitions (organization_id, object_type, key, label, field_type, options) values ($1, 'contact', 'size', 'גודל', 'select', '[\"קטן\",\"בינוני\",\"גדול\"]'), ($1, 'contact', 'tags2', 'תחומים', 'multi_select', '[\"א\",\"ב\"]')",
        [org],
      ),
    );
    let next = 0;
    const many = async (n: number, cf: Record<string, unknown>) => {
      const start = next;
      next += n;
      // each with its own phone, so none of them is a duplicate
      await asAdmin((q) =>
        q(
          "insert into public.contacts (organization_id, first_name, phone, custom_fields) select $1, 'רבים', '054-' || lpad((g + $4)::text, 7, '0'), $3::jsonb from generate_series(1, $2) g",
          [org, n, JSON.stringify(cf), start],
        ),
      );
    };
    await many(48, { size: "קטן", tags2: ["א", "ב"] });
    await many(1, { size: "בינוני", tags2: ["א"] });
    // 49 filled: not judged yet
    expect((await suggestions(owner)).rare_options.count).toBe(0);
    await many(1, { size: "קטן", tags2: ["א"] });
    const s = await suggestions(owner);
    expect(s.rare_options.items.map((i) => [i.field_key, i.option, i.used, i.filled])).toEqual([
      ["size", "בינוני", 1, 50],
      ["size", "גדול", 0, 50],
    ]);
    expect(s.rare_options).toMatchObject({ count: 2, min_filled: 50, max_used: 1 });
  });

  it("the limit cuts the items, never the counts", async () => {
    const s = await suggestions(owner, org, 1);
    expect(s.duplicates.items).toHaveLength(1);
    expect(s.duplicates.count).toBe(4);
    const none = await suggestions(owner, org, 0);
    expect(none.duplicates.items).toEqual([]);
    expect(none.rare_options.count).toBe(2);
  });

  // review 7: owners, admins and managers only (canSeeCleanup)
  it("refuses anyone but owners, admins and managers: {allowed: false}", async () => {
    for (const user of [member, viewer, outsider]) {
      expect(await asUser(user.id, async (q) => (await q<{ r: unknown }>("select public.cleanup_suggestions($1) as r", [org])).rows[0].r)).toEqual({
        allowed: false,
      });
    }
    expect((await suggestions(manager)).allowed).toBe(true);
    expect((await suggestions(admin)).allowed).toBe(true);
  });

  it("RLS decides what a manager counts: with 'own' visibility, only the records they read", async () => {
    expect((await suggestions(manager)).duplicates.count).toBe(4);
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const m = await suggestions(manager);
      expect(m.duplicates.count).toBe(0);
      expect(m.no_channel.count).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a switched-off module is left out", async () => {
    await asUser(owner.id, (q) => q("insert into public.org_modules (organization_id, leads_enabled, companies_enabled) values ($1, false, false)", [org]));
    try {
      const s = await suggestions(owner);
      expect(s.duplicates.items.map((i) => i.type)).toEqual(["contact"]);
      expect(s.unowned_leads.count).toBe(0);
      expect(s.no_channel.leads).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.org_modules set leads_enabled = true, companies_enabled = true where organization_id = $1", [org]));
    }
  });

  it("the weekly notice: owners and admins, counts only, once a week per business", async () => {
    const due = await asAdmin(async (q) => {
      const r = await q<{ due: boolean }>("select app.cleanup_week_due($1, now() at time zone 'Asia/Jerusalem') is not null as due", [org]);
      return r.rows[0].due;
    });
    const run = () => asAdmin(async (q) => (await q<{ n: number }>("select app.send_cleanup_suggestions($1) as n", [[org]])).rows[0].n);
    const notices = () =>
      asAdmin(async (q) =>
        (
          await q<{ user_id: string; title: string; body: string; entity_type: string; entity_id: string }>(
            "select user_id, title, body, entity_type, entity_id from public.notifications where organization_id = $1 and entity_type = 'cleanup_suggestions'",
            [org],
          )
        ).rows,
      );
    const first = await run();
    if (!due) {
      // before 09:00 of this week's send day in the business's zone: not yet this week
      expect(first).toBe(0);
      return;
    }
    expect(first).toBe(1);
    const sent = await notices();
    expect(sent.map((n) => n.user_id).sort()).toEqual([owner.id, admin.id].sort());
    expect(sent[0]).toMatchObject({ title: "הצעות ניקוי לשבוע הזה", entity_id: org });
    expect(sent[0].body).toBe("כפילויות חדשות: 4 · בלי אחראי: 1 · בלי טלפון ובלי אימייל: 2 · ערכי בחירה שכמעט לא בשימוש: 2");
    // once a week
    expect(await run()).toBe(0);
    expect(await notices()).toHaveLength(2);
    // a business with nothing to clean is marked done, with no notice
    const quiet = await createOrg(outsider.id, "עסק שקט");
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select app.send_cleanup_suggestions($1) as n", [[quiet]])).rows[0].n)).toBe(1);
    expect(await asAdmin(async (q) => (await q("select 1 from public.notifications where organization_id = $1 and entity_type = 'cleanup_suggestions'", [quiet])).rowCount)).toBe(0);
  });

  // owner (62) א: Sunday 09:00 in the business's zone; when Sunday is a rest day (CAL-03), 09:00 on the next working day
  it("the notice is due from Sunday 09:00, or from 09:00 on the next working day when Sunday is a rest day", async () => {
    const weekDue = (orgId: string, local: string) =>
      asAdmin(async (q) =>
        (await q<{ d: string | null }>("select to_char(app.cleanup_week_due($1, $2::timestamp), 'YYYY-MM-DD') as d", [orgId, local])).rows[0].d,
      );
    // 1 November 2026 is a Sunday, no holiday; the default calendar rests on Friday and Saturday
    expect(await weekDue(org, "2026-11-01 08:59")).toBeNull();
    expect(await weekDue(org, "2026-11-01 09:00")).toBe("2026-11-01");
    expect(await weekDue(org, "2026-11-07 12:00")).toBe("2026-11-01");
    expect(await weekDue(org, "2026-11-08 08:00")).toBeNull();

    const sundayOwner = await createUser("cln-sunday");
    const sundayOrg = await createOrg(sundayOwner.id, "עסק שנח ביום ראשון");
    await asUser(sundayOwner.id, (q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays) values ($1, '{0,6}')
         on conflict (organization_id) do update set rest_weekdays = excluded.rest_weekdays`,
        [sundayOrg],
      ),
    );
    expect(await weekDue(sundayOrg, "2026-11-01 10:00")).toBeNull();
    expect(await weekDue(sundayOrg, "2026-11-02 08:59")).toBeNull();
    expect(await weekDue(sundayOrg, "2026-11-02 09:00")).toBe("2026-11-01");
    expect(await weekDue(sundayOrg, "2026-11-06 18:00")).toBe("2026-11-01");
    // the job sends nothing to it on its rest Sunday: it is not even picked
    const picked = await asAdmin(async (q) => {
      const local = (await q<{ dow: number; t: string }>("select extract(dow from now() at time zone 'Asia/Jerusalem')::int as dow, ((now() at time zone 'Asia/Jerusalem')::time)::text as t")).rows[0];
      return { sunday: local.dow === 0, run: (await q<{ n: number }>("select app.send_cleanup_suggestions($1) as n", [[sundayOrg]])).rows[0].n };
    });
    if (picked.sunday) expect(picked.run).toBe(0);
  });

  // review 1: a time budget across businesses
  it("a run stops taking businesses once its time budget is spent, after serving at least one", async () => {
    const quiet = await Promise.all([1, 2, 3].map(async (n) => createOrg(outsider.id, `עסק שקט ${n}`)));
    const served = await asAdmin(async (q) => {
      await q("select set_config('app.cleanup_suggestion_budget_ms', '0', true)");
      const n = (await q<{ n: number }>("select app.send_cleanup_suggestions($1) as n", [quiet])).rows[0].n;
      const due = (await q<{ n: number }>("select count(*)::int as n from unnest($1::uuid[]) o where app.cleanup_week_due(o, now() at time zone 'Asia/Jerusalem') is not null", [quiet])).rows[0].n;
      return { n, due };
    });
    // a week not yet due serves none; otherwise exactly one of the three
    expect(served.n).toBe(served.due > 0 ? 1 : 0);
  });

  // review 8: a calendar that cannot be read skips the business with one warning line, not silently
  it("a calendar that cannot be read gives null and one warning with the business and SQLSTATE", async () => {
    const notices: string[] = [];
    const client = new Client({ connectionString: TEST_DB_URL });
    client.on("notice", (n) => notices.push(n.message ?? ""));
    await client.connect();
    try {
      await client.query("begin");
      // only inside this transaction, rolled back below
      await client.query(`create or replace function app.add_business_days(p_org uuid, p_from date, p_n integer) returns date
                          language plpgsql stable set search_path = '' as $f$
                          begin raise exception 'calendar refused by the test' using errcode = 'P0001'; end $f$`);
      const res = await client.query<{ d: string | null }>("select app.cleanup_week_due($1, '2026-11-01 10:00'::timestamp)::text as d", [org]);
      expect(res.rows[0].d).toBeNull();
    } finally {
      await client.query("rollback");
      await client.end();
    }
    expect(notices).toEqual([`crm-cleanup-suggestions: the calendar of organization ${org} cannot be read (SQLSTATE P0001)`]);
  });

  it("the job is not callable by API roles", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("select app.send_cleanup_suggestions()")))).code).toBe("42501");
  });
});
