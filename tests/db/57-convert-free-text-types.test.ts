import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

// CON-02 (owner, 12 October 2026): a one-time conversion of the old free-text
// contact_type / company_type into type_id, on an exact match only.

const MIGRATION = "convert_free_text_types.sql";

function migrationText(): string {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const file = readdirSync(dir).find((f) => f.endsWith(MIGRATION));
  if (!file) throw new Error(`no migration *${MIGRATION}`);
  return readFileSync(path.join(dir, file), "utf8");
}

type Row = { id: string; text: string | null; type_id: string | null; updated_at: string };

describe("free-text contact and company types become type_id (CON-02)", () => {
  let org: string, otherOrg: string;
  const types: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const contact = (o: string, text: string, typeId: string | null = null) =>
    asAdmin(async (q) =>
      (
        await q<{ id: string }>("insert into public.contacts (organization_id, first_name, contact_type, type_id) values ($1, 'איש', $2, $3) returning id", [
          o,
          text,
          typeId,
        ])
      ).rows[0].id,
    );
  const company = (o: string, text: string) =>
    asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.companies (organization_id, name, company_type) values ($1, 'חברה', $2) returning id", [o, text])).rows[0].id,
    );
  const contactRow = (id: string) =>
    asAdmin(async (q) => (await q<Row>("select id, contact_type as text, type_id, updated_at::text from public.contacts where id = $1", [id])).rows[0]);
  const companyRow = (id: string) =>
    asAdmin(async (q) => (await q<Row>("select id, company_type as text, type_id, updated_at::text from public.companies where id = $1", [id])).rows[0]);

  beforeAll(async () => {
    const owner = await createUser("ft-owner");
    org = await createOrg(owner.id, "עסק עם סוגים ישנים");
    otherOrg = await createOrg(owner.id, "עסק אחר");
    // the default types (0098) are there; one is hidden, and org has one type of its own
    await asUser(owner.id, (q) => q("update public.record_type_options set is_active = false where organization_id = $1 and object_type = 'contact' and name = 'שותף'", [org]));
    await asUser(owner.id, (q) => q("insert into public.record_type_options (organization_id, object_type, name) values ($1, 'contact', 'VIP')", [org]));
    const rows = await asAdmin(async (q) =>
      (await q<{ id: string; object_type: string; name: string }>("select id, object_type, name from public.record_type_options where organization_id = $1", [org])).rows,
    );
    for (const r of rows) types[`${r.object_type}:${r.name}`] = r.id;

    ids.exact = await contact(org, "ספק");
    ids.spaces = await contact(org, "  לקוח \t  פוטנציאלי ");
    ids.different = await contact(org, "ספקים");
    ids.caseOnly = await contact(org, "vip");
    ids.hidden = await contact(org, "שותף");
    ids.trailingSpace = await contact(org, "VIP ");
    ids.typed = await contact(org, "לקוח", types["contact:ספק"]);
    ids.foreign = await contact(otherOrg, "VIP");
    ids.company = await company(org, "מתחרה");
    ids.companyNoMatch = await company(org, "VIP");
  });

  it("converts exact matches only, leaves everything else, and never changes the old text", async () => {
    const before = await asAdmin(async (q) => (await q<{ n: number }>("select coalesce(max(id), 0)::int as n from public.outbox_events")).rows[0].n);
    const setting = await asAdmin(async (q) => {
      await q("select set_config('app.automation_running', 'off', true)");
      await q(migrationText());
      // the previous value is put back
      return (await q<{ v: string }>("select current_setting('app.automation_running', true) as v")).rows[0].v;
    });
    expect(setting).toBe("off");

    expect((await contactRow(ids.exact)).type_id).toBe(types["contact:ספק"]);
    expect((await contactRow(ids.spaces)).type_id).toBe(types["contact:לקוח פוטנציאלי"]);
    expect((await contactRow(ids.trailingSpace)).type_id).toBe(types["contact:VIP"]);
    expect((await companyRow(ids.company)).type_id).toBe(types["company:מתחרה"]);
    // no match: a different text, case only, a hidden type, another organization's type, a company with a contact-only type
    expect((await contactRow(ids.different)).type_id).toBeNull();
    expect((await contactRow(ids.caseOnly)).type_id).toBeNull();
    expect((await contactRow(ids.hidden)).type_id).toBeNull();
    expect((await contactRow(ids.foreign)).type_id).toBeNull();
    expect((await companyRow(ids.companyNoMatch)).type_id).toBeNull();
    // a row that already had a type keeps it
    expect((await contactRow(ids.typed)).type_id).toBe(types["contact:ספק"]);
    // the old text is untouched
    expect((await contactRow(ids.spaces)).text).toBe("  לקוח \t  פוטנציאלי ");
    expect((await contactRow(ids.exact)).text).toBe("ספק");
    expect((await companyRow(ids.company)).text).toBe("מתחרה");

    // the events of the conversion are marked as automation, so no automation reacts
    const events = await asAdmin(async (q) =>
      (
        await q<{ entity_id: string; event_type: string; origin: string | null }>(
          "select entity_id, event_type, payload ->> 'origin' as origin from public.outbox_events where id > $1 and entity_type in ('contact', 'company')",
          [before],
        )
      ).rows,
    );
    expect(events.map((e) => e.entity_id).sort()).toEqual([ids.exact, ids.spaces, ids.trailingSpace, ids.company].sort());
    expect(events.every((e) => e.origin === "automation" && e.event_type.endsWith(".updated"))).toBe(true);
    // one audit entry per converted row, with no actor
    const audit = await asAdmin(async (q) =>
      (
        await q<{ n: number }>(
          "select count(*)::int as n from public.audit_log where entity_id = any($1::uuid[]) and action = 'update' and actor_id is null and changes ? 'type_id'",
          [[ids.exact, ids.spaces, ids.trailingSpace, ids.company]],
        )
      ).rows[0].n,
    );
    expect(audit).toBe(4);
  });

  it("a second run changes nothing", async () => {
    const all = Object.values(ids);
    const snapshot = async () =>
      asAdmin(async (q) =>
        (
          await q<{ id: string; type_id: string | null; updated_at: string }>(
            "select id, type_id, updated_at::text from public.contacts where id = any($1::uuid[]) union all select id, type_id, updated_at::text from public.companies where id = any($1::uuid[]) order by 1",
            [all],
          )
        ).rows,
      );
    const before = await snapshot();
    const lastEvent = await asAdmin(async (q) => (await q<{ n: number }>("select coalesce(max(id), 0)::int as n from public.outbox_events")).rows[0].n);
    await asAdmin((q) => q(migrationText()));
    expect(await snapshot()).toEqual(before);
    const newEvents = await asAdmin(async (q) =>
      (await q<{ n: number }>("select count(*)::int as n from public.outbox_events where id > $1 and entity_id = any($2::uuid[])", [lastEvent, all])).rows[0].n,
    );
    expect(newEvents).toBe(0);
  });
});
