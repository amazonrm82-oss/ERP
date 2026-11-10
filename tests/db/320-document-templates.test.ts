import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { unknownDocumentFields } from "@/features/document-templates/fields";
import { DEFAULT_DOCUMENT_TEMPLATES } from "@/features/document-templates/templates";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

const INSERT = "insert into public.document_templates (organization_id, name, kind, record_type, body) values ($1, $2, $3, $4, $5) returning id";

/** SGN-01: document templates (owner (67) ג: plan key `signatures` from "בסיס" up, cap max_signatures_per_month). */
describe("document templates (SGN-01)", () => {
  let owner: { id: string };
  let admin: { id: string };
  let member: { id: string };
  let viewer: { id: string };
  let org: string;
  let n = 0;
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));
  const add = (userId: string, row: { recordType?: string; body?: string; kind?: string; orgId?: string } = {}) =>
    asUser(
      userId,
      async (q) =>
        (await q<{ id: string }>(INSERT, [row.orgId ?? org, `תבנית ${(n += 1)}`, row.kind ?? "contract", row.recordType ?? "contact", row.body ?? "שלום {שם מלא}"]))
          .rows[0].id,
    );

  beforeAll(async () => {
    owner = await createUser("doctpl-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "doctpl-admin");
    member = await addMember(org, owner.id, "member", "doctpl-member");
    viewer = await addMember(org, owner.id, "viewer", "doctpl-viewer");
    await setFeatures({ signatures: true });
  });

  it("the plans hold the key and the monthly cap of answer (67) ג", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ key: string; on: boolean | null; cap: string | null; has_cap: boolean }>(
            "select key, (features ->> 'signatures')::boolean as on, limits ->> 'max_signatures_per_month' as cap, limits ? 'max_signatures_per_month' as has_cap from public.plans order by position, key",
          )
        ).rows,
    );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get("personal")).toMatchObject({ on: false, cap: "0" });
    expect(byKey.get("basic")).toMatchObject({ on: true, cap: "20" });
    expect(byKey.get("pro")).toMatchObject({ on: true, cap: "100" });
    expect(byKey.get("business")).toMatchObject({ on: true, cap: null, has_cap: true });
    for (const row of rows) expect(row.on, row.key).not.toBeNull();
    const fallback = await asAdmin(async (q) => (await q<{ f: boolean; l: number }>("select (app.plan_key_defaults() -> 'features' ->> 'signatures')::boolean as f, (app.plan_key_defaults() -> 'limits' ->> 'max_signatures_per_month')::int as l")).rows[0]);
    expect(fallback).toEqual({ f: false, l: 0 });
  });

  it("a new business starts with the defaults, marked as draft wording, read by every member", async () => {
    for (const reader of [member, viewer]) {
      const rows = await asUser(
        reader.id,
        async (q) =>
          (
            await q<{ name: string; kind: string; record_type: string; body: string; is_active: boolean; draft_wording: boolean }>(
              "select name, kind, record_type, body, is_active, draft_wording from public.document_templates where organization_id = $1 order by created_at, name",
              [org],
            )
          ).rows,
      );
      expect(rows).toHaveLength(DEFAULT_DOCUMENT_TEMPLATES.length);
      const byName = new Map(rows.map((row) => [row.name, row]));
      for (const d of DEFAULT_DOCUMENT_TEMPLATES) {
        expect(byName.get(d.name), d.name).toEqual({ name: d.name, kind: d.kind, record_type: d.recordType, body: d.body, is_active: true, draft_wording: true });
        expect(unknownDocumentFields(d.body, d.recordType)).toEqual([]);
      }
    }
  });

  it("owners and admins write; members and viewers do not; draft_wording is the server's", async () => {
    const id = await add(admin.id);
    await add(owner.id);
    for (const u of [member, viewer]) {
      expect((await pgError(add(u.id))).code, "insert").toBe("42501");
      expect((await asUser(u.id, (q) => q("update public.document_templates set name = 'x' where id = $1", [id]))).rowCount).toBe(0);
      expect((await asUser(u.id, (q) => q("delete from public.document_templates where id = $1", [id]))).rowCount).toBe(0);
    }
    expect((await pgError(asUser(owner.id, (q) => q("update public.document_templates set draft_wording = true where id = $1", [id])))).code).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.document_templates (organization_id, name, record_type, body, draft_wording) values ($1, 'טיוטה', 'contact', 'x', true)", [org])))).code,
    ).toBe("42501");
    expect((await asUser(admin.id, (q) => q("delete from public.document_templates where id = $1", [id]))).rowCount).toBe(1);
  });

  it("changing a default's wording clears the draft mark; renaming it does not", async () => {
    const draft = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.document_templates where organization_id = $1 and kind = 'joining_form'", [org])).rows[0].id);
    const mark = () => asAdmin(async (q) => (await q<{ d: boolean }>("select draft_wording as d from public.document_templates where id = $1", [draft])).rows[0].d);
    await asUser(admin.id, (q) => q("update public.document_templates set name = 'טופס הצטרפות ללקוח', is_active = false where id = $1", [draft]));
    expect(await mark()).toBe(true);
    await asUser(admin.id, (q) => q("update public.document_templates set body = body || ' ' || '{שם פרטי}' where id = $1", [draft]));
    expect(await mark()).toBe(false);
  });

  it("the seed marks each default with its kind code, kept through edits; the key is the server's", async () => {
    const keys = await asAdmin(
      async (q) =>
        (await q<{ key: string | null; kind: string }>("select key, kind from public.document_templates where organization_id = $1 and key is not null order by key", [org])).rows,
    );
    expect(keys.map((k) => k.key).sort()).toEqual(DEFAULT_DOCUMENT_TEMPLATES.map((d) => d.kind).sort());
    for (const k of keys) expect(k.key).toBe(k.kind);
    const id = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.document_templates where organization_id = $1 and key = 'contract'", [org])).rows[0].id);
    expect((await pgError(asUser(owner.id, (q) => q("update public.document_templates set key = null where id = $1", [id])))).code).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.document_templates (organization_id, name, record_type, body, key) values ($1, 'סימון', 'contact', 'x', 'contract')", [org])))).code,
    ).toBe("42501");
    // a person-made template carries no key
    const own = await add(admin.id);
    expect(await asAdmin(async (q) => (await q<{ key: string | null }>("select key from public.document_templates where id = $1", [own])).rows[0].key)).toBeNull();
  });

  it("only the record type's merge fields, and a well-formed gender block", async () => {
    expect((await pgError(add(admin.id, { body: "{לא קיים}" }))).hint).toBe("document_template:field");
    // a deal's field is not a contact's
    expect((await pgError(add(admin.id, { body: "{שם העסקה}" }))).hint).toBe("document_template:field");
    const deal = await add(admin.id, { recordType: "deal", body: "{שם העסקה} {סכום העסקה} {שם העסק}" });
    // judged again when the record type changes
    expect((await pgError(asUser(admin.id, (q) => q("update public.document_templates set record_type = 'contact' where id = $1", [deal])))).hint).toBe(
      "document_template:field",
    );
    expect((await pgError(add(admin.id, { body: "{זכר: חתום | נקבה: חתומה}" }))).hint).toBe("document_template:neutral");
    expect((await pgError(add(admin.id, { body: "{זכר: א | זכר: ב | ניטרלי: ג}" }))).hint).toBe("document_template:variant");
    await add(admin.id, { body: "{זכר: חתום | נקבה: חתומה | ניטרלי: חתום/ה} {תעודת זהות}" });
    await add(admin.id, { recordType: "company", body: "{מספר החברה} {שם לחיוב}" });
    await add(admin.id, { recordType: "lead", body: "{שם החברה} {תפקיד}" });
    // the closed lists and the length
    expect((await pgError(add(admin.id, { kind: "will" }))).code).toBe("23514");
    expect((await pgError(add(admin.id, { recordType: "task", body: "x" }))).code).toBe("23514");
    expect((await pgError(add(admin.id, { body: "א".repeat(20001) }))).code).toBe("23514");
    await add(admin.id, { body: "א".repeat(20000) });
  });

  it("without the plan key a person cannot add, change or switch on a template, and may still switch one off or remove it (owner (201) ב)", async () => {
    const id = await add(admin.id);
    const other = await add(admin.id);
    await setFeatures({ signatures: false });
    try {
      const update = (sql: string, target = id) => asUser(owner.id, (q) => q(`update public.document_templates set ${sql} where id = $1`, [target]));
      const active = async (target: string) =>
        asAdmin(async (q) => (await q<{ a: boolean }>("select is_active as a from public.document_templates where id = $1", [target])).rows[0].a);
      expect((await pgError(add(admin.id))).hint).toBe("feature:signatures");
      expect((await pgError(update("name = 'חדש'"))).hint).toBe("feature:signatures");
      expect((await pgError(update("body = 'שלום {שם פרטי}'"))).hint).toBe("feature:signatures");
      // switching off together with another change is a change
      expect((await pgError(update("is_active = false, name = 'חדש'"))).hint).toBe("feature:signatures");
      expect(await active(id)).toBe(true);
      // switching off alone is allowed, also by an admin; a no-op on an inactive one is not a switch-off
      expect((await update("is_active = false")).rowCount).toBe(1);
      expect(await active(id)).toBe(false);
      expect((await asUser(admin.id, (q) => q("update public.document_templates set is_active = false where id = $1", [other]))).rowCount).toBe(1);
      expect((await pgError(update("is_active = true"))).hint).toBe("feature:signatures");
      expect((await pgError(update("is_active = false"))).hint).toBe("feature:signatures");
      expect(await active(id)).toBe(false);
      // members and viewers still change nothing
      for (const u of [member, viewer]) {
        expect((await asUser(u.id, (q) => q("update public.document_templates set is_active = false where id = $1", [id]))).rowCount).toBe(0);
      }
      expect((await asUser(owner.id, (q) => q("delete from public.document_templates where id = $1", [id]))).rowCount).toBe(1);
      expect((await asUser(admin.id, (q) => q("delete from public.document_templates where id = $1", [other]))).rowCount).toBe(1);
    } finally {
      await setFeatures({ signatures: true });
    }
    // with the key, switching on again works
    const back = await add(admin.id);
    await asUser(admin.id, (q) => q("update public.document_templates set is_active = false where id = $1", [back]));
    expect((await asUser(admin.id, (q) => q("update public.document_templates set is_active = true where id = $1", [back]))).rowCount).toBe(1);
  });

  it("the seed's setting alone opens nothing: a person's insert without the server-only key is judged as a person's", async () => {
    const seeded = (userId: string) =>
      asUser(userId, (q) =>
        q(
          "with s as (select set_config('app.document_template_seed', $1::uuid::text, true)) insert into public.document_templates (organization_id, name, record_type, body) select $1::uuid, 'עקיפה ' || gen_random_uuid(), 'contact', 'x' from s returning id",
          [org],
        ),
      );
    await setFeatures({ signatures: false });
    try {
      expect((await pgError(seeded(admin.id))).hint).toBe("feature:signatures");
      expect((await pgError(seeded(owner.id))).hint).toBe("feature:signatures");
      expect((await pgError(seeded(member.id))).code).toBe("42501");
    } finally {
      await setFeatures({ signatures: true });
    }
  });

  it("a read-only business keeps its templates readable and frozen, for owners too", async () => {
    const id = await add(admin.id);
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await asUser(member.id, async (q) => (await q("select 1 from public.document_templates where id = $1", [id])).rowCount)).toBe(1);
      for (const u of [owner, admin]) {
        expect((await pgError(add(u.id))).code, "insert").toBe("42501");
        expect((await asUser(u.id, (q) => q("update public.document_templates set name = 'x' where id = $1", [id]))).rowCount, "update").toBe(0);
        expect((await asUser(u.id, (q) => q("update public.document_templates set is_active = false where id = $1", [id]))).rowCount, "switch off").toBe(0);
        expect((await asUser(u.id, (q) => q("delete from public.document_templates where id = $1", [id]))).rowCount, "delete").toBe(0);
      }
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
    expect((await asUser(admin.id, (q) => q("delete from public.document_templates where id = $1", [id]))).rowCount).toBe(1);
  });

  it("an outsider learns nothing about another business's plan or list", async () => {
    const stranger = await createUser("doctpl-stranger");
    const own = await createOrg(stranger.id);
    expect((await pgError(add(stranger.id, { orgId: org }))).code).toBe("42501");
    expect(await asUser(stranger.id, async (q) => (await q("select 1 from public.document_templates where organization_id = $1", [org])).rowCount)).toBe(0);
    // the stranger's own business got its own defaults
    expect(await asUser(stranger.id, async (q) => (await q("select 1 from public.document_templates where organization_id = $1", [own])).rowCount)).toBe(DEFAULT_DOCUMENT_TEMPLATES.length);
  });

  it("is audited", async () => {
    const id = await add(admin.id);
    await asUser(admin.id, (q) => q("update public.document_templates set name = name || ' (עודכן)' where id = $1", [id]));
    const entries = await asAdmin(
      async (q) => (await q<{ action: string }>("select action from public.audit_log where organization_id = $1 and entity_type = 'document_templates' and entity_id = $2 order by created_at", [org, id])).rows,
    );
    expect(entries.map((e) => e.action)).toEqual(["insert", "update"]);
  });

  it("at most 50 per business (hint document_templates:max)", async () => {
    const have = await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.document_templates where organization_id = $1", [org])).rows[0].n);
    await asUser(admin.id, (q) =>
      q("insert into public.document_templates (organization_id, name, record_type, body) select $1, 'מילוי ' || g, 'contact', 'x' from generate_series(1, 50 - $2::int) g", [org, have]),
    );
    expect((await pgError(add(admin.id))).hint).toBe("document_templates:max");
  });

});
