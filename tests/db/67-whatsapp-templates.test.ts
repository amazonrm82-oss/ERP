import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_TEMPLATES } from "@/features/whatsapp/templates";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

/** The last statement of the migration: the seed of the organizations that already exist. */
function backfillStatement(): string {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_whatsapp_templates.sql"));
  if (!file) throw new Error("no migration *_whatsapp_templates.sql");
  const sql = readFileSync(path.join(dir, file), "utf8");
  return sql.slice(sql.lastIndexOf("\nselect app.seed_whatsapp_templates") + 1);
}

// WA-01: WhatsApp text templates, a managed list; the message is logged as a 'whatsapp' activity.
describe("WhatsApp templates (WA-01)", () => {
  let owner: U, admin: U, member: U, viewer: U;
  let org: string;

  const templatesOf = (o: string) =>
    asAdmin(async (q) =>
      (
        await q<{ name: string; body: string; kind: string | null; position: number }>(
          "select name, body, kind, position from public.whatsapp_templates where organization_id = $1 order by position, name collate \"C\"",
          [o],
        )
      ).rows,
    );

  beforeAll(async () => {
    owner = await createUser("wa-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "wa-admin");
    member = await addMember(org, owner.id, "member", "wa-member");
    viewer = await addMember(org, owner.id, "viewer", "wa-viewer");
  });

  it("a new organization starts with the default templates, in order, one of them the meeting reminder", async () => {
    const rows = await templatesOf(org);
    expect(rows.map((r) => ({ name: r.name, body: r.body, kind: r.kind }))).toEqual(DEFAULT_TEMPLATES.map((t) => ({ name: t.name, body: t.body, kind: t.kind })));
    expect(rows.map((r) => r.position)).toEqual(DEFAULT_TEMPLATES.map((_, i) => i));
    // the creator is the actor of the seed in the audit log
    expect(
      (
        await asAdmin((q) =>
          q<{ actor_id: string | null }>("select distinct actor_id from public.audit_log where organization_id = $1 and entity_type = 'whatsapp_templates'", [org]),
        )
      ).rows,
    ).toEqual([{ actor_id: owner.id }]);
  });

  it("the backfill seeds only organizations without any template, and is safe to run twice", async () => {
    const emptied = await createOrg(owner.id, "עסק שמחק הכול");
    const custom = await createOrg(owner.id, "עסק עם תבנית משלו");
    await asUser(owner.id, async (q) => {
      await q("delete from public.whatsapp_templates where organization_id = $1", [emptied]);
      await q("delete from public.whatsapp_templates where organization_id = $1", [custom]);
      await q("insert into public.whatsapp_templates (organization_id, name, body) values ($1, 'שלנו', 'שלום {שם פרטי}')", [custom]);
    });
    const statement = backfillStatement();
    await asAdmin((q) => q(statement));
    await asAdmin((q) => q(statement));
    expect((await templatesOf(emptied)).map((r) => r.name)).toEqual(DEFAULT_TEMPLATES.map((t) => t.name));
    expect((await templatesOf(custom)).map((r) => r.name)).toEqual(["שלנו"]);
    expect((await templatesOf(org)).length).toBe(DEFAULT_TEMPLATES.length);
  });

  it("every member reads the list; only owners and admins change it", async () => {
    for (const u of [member, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.whatsapp_templates where organization_id = $1", [org])).toBe(DEFAULT_TEMPLATES.length);
        expect((await q("update public.whatsapp_templates set name = name where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("delete from public.whatsapp_templates where organization_id = $1", [org])).rowCount).toBe(0);
      });
      expect((await pgError(asUser(u.id, (q) => q("insert into public.whatsapp_templates (organization_id, name, body) values ($1, 'x', 'x')", [org])))).code).toBe(
        "42501",
      );
    }
    await asUser(admin.id, async (q) => {
      const id = (await q<{ id: string }>("insert into public.whatsapp_templates (organization_id, name, body, position) values ($1, 'הצעה נשלחה', 'שלום {שם פרטי}', 9) returning id", [org])).rows[0].id;
      expect((await q("update public.whatsapp_templates set body = 'נוסח חדש' where id = $1", [id])).rowCount).toBe(1);
      expect((await q("delete from public.whatsapp_templates where id = $1", [id])).rowCount).toBe(1);
    });
  });

  it("kind belongs to the server, names are unique ignoring case, texts are checked", async () => {
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.whatsapp_templates (organization_id, name, body, kind) values ($1, 'y', 'y', 'meeting_reminder')", [org])))).code,
    ).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.whatsapp_templates set kind = null where organization_id = $1", [org])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.whatsapp_templates set organization_id = organization_id where organization_id = $1", [org])))).code).toBe(
      "42501",
    );
    await asUser(owner.id, (q) => q("insert into public.whatsapp_templates (organization_id, name, body) values ($1, 'Hello', 'x')", [org]));
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.whatsapp_templates (organization_id, name, body) values ($1, 'hello', 'x')", [org])))).code).toBe("23505");
    for (const [name, body] of [
      ["", "x"],
      [" רווח", "x"],
      ["x".repeat(81), "x"],
      ["ארוך", "x".repeat(1001)],
      ["ריק", ""],
    ]) {
      expect((await pgError(asUser(owner.id, (q) => q("insert into public.whatsapp_templates (organization_id, name, body) values ($1, $2, $3)", [org, name, body])))).code, name).toBe(
        "23514",
      );
    }
    await asUser(owner.id, (q) => q("delete from public.whatsapp_templates where organization_id = $1 and name = 'Hello'", [org]));
  });

  it("at most 50 templates per organization", async () => {
    const other = await createOrg(owner.id, "עסק עם הרבה תבניות");
    await asUser(owner.id, (q) =>
      q("insert into public.whatsapp_templates (organization_id, name, body) select $1, 'תבנית ' || g, 'x' from generate_series(1, $2::int) g", [other, 50 - DEFAULT_TEMPLATES.length]),
    );
    const error = await pgError(asUser(owner.id, (q) => q("insert into public.whatsapp_templates (organization_id, name, body) values ($1, 'עוד אחת', 'x')", [other])));
    expect(error.code).toBe("P0001");
    expect(error.hint).toBe("whatsapp_templates:max");
  });

  it("a read-only organization keeps its list but cannot change it", async () => {
    const frozen = await createOrg(owner.id, "עסק בקריאה בלבד");
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [frozen]));
    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.whatsapp_templates where organization_id = $1", [frozen])).toBe(DEFAULT_TEMPLATES.length);
      expect((await q("update public.whatsapp_templates set name = name where organization_id = $1", [frozen])).rowCount).toBe(0);
      expect((await q("delete from public.whatsapp_templates where organization_id = $1", [frozen])).rowCount).toBe(0);
    });
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.whatsapp_templates (organization_id, name, body) values ($1, 'x', 'x')", [frozen])))).code).toBe(
      "42501",
    );
  });

  it("the message is logged as a WhatsApp entry by whoever can write, and counts as contact", async () => {
    const lead = await insertLead(member.id, org, { full_name: "דנה כהן" });
    await asUser(member.id, (q) =>
      q(
        "insert into public.activities (organization_id, lead_id, type, body, metadata) values ($1, $2, 'whatsapp', 'שלום דנה', '{\"via\": \"link\", \"template_name\": \"פנייה ראשונה\"}')",
        [org, lead],
      ),
    );
    const stamp = await asAdmin(async (q) => (await q<{ last_contacted_at: string | null }>("select last_contacted_at from public.leads where id = $1", [lead])).rows[0]);
    expect(stamp.last_contacted_at).not.toBeNull();
    // a viewer cannot log one
    expect(
      (await pgError(asUser(viewer.id, (q) => q("insert into public.activities (organization_id, lead_id, type, body) values ($1, $2, 'whatsapp', 'x')", [org, lead])))).code,
    ).toBe("42501");
  });
});
