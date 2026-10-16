import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isEmptyCustomValue, UNIQUE_TYPES } from "@/features/custom-fields/settings";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultLeadStatus, insertLead, pgError, TEST_DB_URL } from "./helpers";

afterAll(closePool);

// FLD-07 (migration field_settings): unique, default value and read-only on a custom field.
type DbError = { code?: string; hint?: string; detail?: string; message: string };
const failure = async (promise: Promise<unknown>) => (await pgError(promise)) as DbError;

describe("custom field settings (FLD-07)", () => {
  let owner: { id: string }, rep: { id: string }, other: { id: string };
  let org: string, otherOrg: string;

  const define = (o: string, object: string, key: string, type: string, extra: Record<string, unknown> = {}) =>
    asAdmin((q) =>
      q(
        `insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, is_unique, is_read_only, default_value, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          o,
          object,
          key,
          (extra.label as string) ?? key,
          type,
          JSON.stringify(extra.options ?? []),
          extra.unique ?? false,
          extra.readOnly ?? false,
          extra.default === undefined ? null : JSON.stringify(extra.default),
          extra.active ?? true,
        ],
      ),
    );
  const customOf = (table: string, id: string) =>
    asAdmin(async (q) => (await q<{ c: Record<string, unknown> }>(`select custom_fields as c from public.${table} where id = $1`, [id])).rows[0].c);
  const lead = (userId: string, custom: unknown, o = org) => insertLead(userId, o, { custom_fields: JSON.stringify(custom) });
  const clashes = (userId: string, type: string, ids: string[], o = org) =>
    asUser(userId, async (q) =>
      (await q("select record_id, field_key, field_label, other_id from public.custom_unique_clashes($1, $2, $3) order by record_id, field_key", [o, type, ids])).rows,
    ).then((rows) => rows.map((r) => ({ ...r })));
  const setField = (userId: string, key: string, set: string, params: unknown[] = []) =>
    asUser(userId, (q) => q(`update public.field_definitions set ${set} where organization_id = $1 and key = $2 returning id`, [org, key, ...params]));

  beforeAll(async () => {
    owner = await createUser("fs-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member");
    other = await createUser("fs-other");
    otherOrg = await createOrg(other.id);
    await define(org, "lead", "tier", "select", { options: ["רגיל", "זהב"], default: "רגיל" });
    await define(org, "lead", "vip", "checkbox", { default: true });
    await define(org, "lead", "hidden_def", "text", { default: "x", active: false });
    await define(org, "lead", "origin", "text", { readOnly: true, label: "מקור ראשון" });
    await define(org, "lead", "ext", "text", { unique: true, label: "מזהה חיצוני" });
    await define(org, "lead", "tel2", "phone", { unique: true });
    await define(org, "lead", "num", "number", { unique: true });
    await define(org, "lead", "note", "text");
    await define(otherOrg, "lead", "ext", "text", { unique: true });
    await define(org, "contact", "ext", "text", { unique: true, label: "מזהה חיצוני" });
  });

  describe("the settings", () => {
    it("unique only on types where one value names one record (same list as the app)", async () => {
      for (const type of ["text", "number", "email", "phone", "url", "il_id", "il_company_id"]) {
        expect(UNIQUE_TYPES).toContain(type);
      }
      expect(UNIQUE_TYPES).toHaveLength(7);
      for (const [type, options] of [["select", ["א"]], ["checkbox", []], ["date", []], ["long_text", []], ["multi_select", ["א"]]] as const) {
        const error = await failure(define(org, "deal", `u_${type}`, type, { unique: true, options }));
        expect(error.hint, type).toBe("custom_field:unique_type");
      }
      await define(org, "deal", "u_ok", "email", { unique: true });
    });

    it("a default must fit the field's type and options, also when the options change; none for a user field or a unique one", async () => {
      expect((await failure(define(org, "deal", "d_bad", "number", { default: "שלוש" }))).hint).toBe("custom_field:default");
      expect((await failure(define(org, "deal", "d_sel", "select", { options: ["א"], default: "ב" }))).hint).toBe("custom_field:default");
      expect((await failure(define(org, "deal", "d_user", "user", { default: owner.id }))).hint).toBe("custom_field:default");
      expect((await failure(define(org, "deal", "d_uniq", "text", { unique: true, default: "x" }))).hint).toBe("custom_field:unique_default");
      // removing the option the default uses is refused; a JSON null default means none
      expect((await failure(setField(owner.id, "tier", "options = '[\"זהב\"]'"))).hint).toBe("custom_field:default");
      await define(org, "deal", "d_null", "text", { default: null });
      expect(
        await asAdmin(async (q) => (await q("select default_value from public.field_definitions where organization_id = $1 and key = 'd_null'", [org])).rows[0].default_value),
      ).toBeNull();
    });

    it("only owners and admins change the settings", async () => {
      expect((await setField(rep.id, "note", "is_read_only = true")).rowCount).toBe(0);
      expect((await setField(owner.id, "note", "default_value = '\"שלום\"'")).rowCount).toBe(1);
      await setField(owner.id, "note", "default_value = null");
    });
  });

  describe("default value", () => {
    it("is applied when a person creates a record without the key", async () => {
      const id = await lead(rep.id, { note: "a" });
      expect(await customOf("leads", id)).toEqual({ note: "a", tier: "רגיל", vip: true });
    });

    it("a value sent wins; a key sent empty (null) stays empty", async () => {
      const id = await lead(rep.id, { tier: "זהב", vip: null });
      expect(await customOf("leads", id)).toEqual({ tier: "זהב" });
    });

    it("is not applied on update, nor to records made by server paths, nor for a hidden field", async () => {
      const id = await lead(rep.id, { tier: null, vip: null });
      await asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"note": "b"}}' where id = $1`, [id]));
      expect(await customOf("leads", id)).toEqual({ note: "b" });
      const statusId = await asAdmin(async (q) => (await q("select id from public.lead_statuses where organization_id = $1 and is_default", [org])).rows[0].id);
      const server = await asAdmin(async (q) =>
        (await q("insert into public.leads (organization_id, status_id, full_name) values ($1, $2, 'שרת') returning id", [org, statusId])).rows[0].id as string,
      );
      expect(await customOf("leads", server)).toEqual({});
    });

    it("is applied to rows an import creates (the person's session)", async () => {
      const job = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows) values ($1, 'lead', 'f.csv', 'skip', 1) returning id",
            [org],
          )
        ).rows[0].id,
      );
      const id = await insertLead(owner.id, org, { import_job_id: job, custom_fields: JSON.stringify({ note: "מיובא" }) });
      expect(await customOf("leads", id)).toEqual({ note: "מיובא", tier: "רגיל", vip: true });
    });
  });

  describe("default value: public forms, conversion, a default that no longer fits (owner, 13 October 2026)", () => {
    let dOrg: string;
    const entriesOf = (column: string, id: string) =>
      asAdmin(async (q) =>
        (await q<{ body: string }>(`select body from public.activities where ${column} = $1 and type = 'system' and metadata->>'kind' = 'default_skipped' order by created_at`, [id])).rows.map((r) => r.body),
      );
    const breakDefault = (key: string, object: string, options: string[]) =>
      asAdmin(async (q) => {
        // the settings check refuses this; only an older definition can get here
        await q("alter table public.field_definitions disable trigger field_definitions_settings_check");
        await q("update public.field_definitions set options = $3 where organization_id = $1 and object_type = $4 and key = $2", [dOrg, key, JSON.stringify(options), object]);
        await q("alter table public.field_definitions enable trigger field_definitions_settings_check");
      });

    beforeAll(async () => {
      dOrg = await createOrg(owner.id, "עסק ברירות מחדל");
      await define(dOrg, "lead", "size", "select", { options: ["קטן", "גדול"], default: "קטן", label: "גודל" });
      await define(dOrg, "lead", "stamp", "text", { readOnly: true, default: "קבוע", label: "חותמת" });
      await define(dOrg, "lead", "note", "text", { label: "הערה" });
      await define(dOrg, "contact", "note", "text", { label: "הערה", default: "ברירת איש קשר" });
      await define(dOrg, "contact", "level", "select", { options: ["א", "ב"], default: "א", label: "רמה" });
      await define(dOrg, "deal", "kind", "text", { default: "רגילה", label: "סוג" });
    });

    it("a public-form lead gets the defaults of fields the form left empty; a value the form sent wins", async () => {
      const token = await asUser(owner.id, async (q) =>
        (await q<{ token: string }>("insert into public.forms (organization_id, name, fields) values ($1, 'טופס', $2) returning token", [
          dOrg,
          JSON.stringify([{ key: "full_name", required: true }, { key: "phone", required: true }, { key: "cf:size", required: false }]),
        ])).rows[0].token,
      );
      const submit = (phone: string, custom: Record<string, unknown>) =>
        asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'form', $2) as r", [token, JSON.stringify({ full_name: "פונה", phone, custom })])).rows[0].r);
      const plain = await submit("052-7700001", {});
      expect(await customOf("leads", plain.lead_id)).toEqual({ size: "קטן", stamp: "קבוע" });
      const chosen = await submit("052-7700002", { size: "גדול" });
      expect(await customOf("leads", chosen.lead_id)).toEqual({ size: "גדול", stamp: "קבוע" });
    });

    it("a default in a read-only field goes in, and is then locked", async () => {
      const id = await lead(owner.id, {}, dOrg);
      expect(await customOf("leads", id)).toMatchObject({ stamp: "קבוע" });
      expect((await failure(asUser(owner.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"stamp": "אחר"}}' where id = $1`, [id])))).hint).toBe(
        "custom_field:read_only",
      );
    });

    it("conversion: the lead's value wins, what is still empty gets the default, the deal too", async () => {
      const convert = async (custom: Record<string, unknown>) => {
        const id = await lead(owner.id, custom, dOrg);
        return asUser(owner.id, async (q) => (await q<{ r: { contact_id: string; deal_id: string } }>("select public.convert_lead($1) as r", [id])).rows[0].r);
      };
      const withNote = await convert({ note: "מהליד" });
      expect(await customOf("contacts", withNote.contact_id)).toEqual({ note: "מהליד", level: "א" });
      expect(await customOf("deals", withNote.deal_id)).toEqual({ kind: "רגילה" });
      const without = await convert({});
      expect(await customOf("contacts", without.contact_id)).toEqual({ note: "ברירת איש קשר", level: "א" });
    });

    it("existing records are never touched, also when a default is added later", async () => {
      const old = await asUser(owner.id, async (q) =>
        (await q<{ id: string }>(`insert into public.contacts (organization_id, first_name, custom_fields) values ($1, 'ותיק', '{"note": null}') returning id`, [dOrg])).rows[0].id,
      );
      expect(await customOf("contacts", old)).toEqual({ level: "א" });
      await define(dOrg, "contact", "later_def", "text", { default: "חדש" });
      expect(await customOf("contacts", old)).toEqual({ level: "א" });
    });

    it("a default that no longer fits is skipped, the record is created, and a system entry says why", async () => {
      await breakDefault("size", "lead", ["בינוני"]);
      const id = await lead(owner.id, {}, dOrg);
      expect(await customOf("leads", id)).toEqual({ stamp: "קבוע" });
      expect(await entriesOf("lead_id", id)).toEqual(["ברירת המחדל של השדה גודל לא נכנסה כי הערך לא תקין"]);
      // no notification for it
      const notes = await asAdmin(async (q) => (await q("select count(*)::int as n from public.notifications where entity_id = $1", [id])).rows[0].n);
      expect(notes).toBe(0);
      await breakDefault("level", "contact", ["ב"]);
      const converted = await asUser(owner.id, async (q) => {
        const leadId = (await q<{ id: string }>(
          "insert into public.leads (organization_id, status_id, full_name) values ($1, (select id from public.lead_statuses where organization_id = $1 and is_default), 'להמרה') returning id",
          [dOrg],
        )).rows[0].id;
        return (await q<{ r: { contact_id: string } }>("select public.convert_lead($1) as r", [leadId])).rows[0].r;
      });
      expect(await customOf("contacts", converted.contact_id)).toEqual({ note: "ברירת איש קשר", later_def: "חדש" });
      // the lead's own entries travel to the contact with the conversion; the contact's default has its own entry
      expect(await entriesOf("contact_id", converted.contact_id)).toContain("ברירת המחדל של השדה רמה לא נכנסה כי הערך לא תקין");
    });
  });

  describe("read-only", () => {
    it("a person fills it on create and then cannot change or clear it", async () => {
      const id = await lead(rep.id, { origin: "פייסבוק" });
      const change = await failure(asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"origin": "גוגל"}}' where id = $1`, [id])));
      expect(change).toMatchObject({ code: "P0001", hint: "custom_field:read_only", detail: "מקור ראשון" });
      const clear = await failure(asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"origin": null}}' where id = $1`, [id])));
      expect(clear.hint).toBe("custom_field:read_only");
      // a whole object without the key removes it too
      const replace = await failure(asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"note": "x"}' where id = $1`, [id])));
      expect(replace.hint).toBe("custom_field:read_only");
      // sending the same value, or changing other fields, is fine
      await asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"origin": "פייסבוק", "note": "y"}}' where id = $1`, [id]));
      await asUser(rep.id, (q) => q("update public.leads set full_name = 'שם אחר' where id = $1", [id]));
      expect(await customOf("leads", id)).toMatchObject({ origin: "פייסבוק", note: "y" });

      // a null for a key the record does not hold changes nothing
      const empty = await lead(rep.id, {});
      await asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"origin": null, "note": "z"}}' where id = $1`, [empty]));
    });

    it("an empty value may be filled once, by anyone who edits the record (imports too); then it is locked", async () => {
      // blank text counts as empty
      const id = await lead(rep.id, { origin: "   " });
      await asUser(owner.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"origin": "  "}}' where id = $1`, [id]));
      // the way an import updates an existing record ({"$merge": filled cells}, the person's session)
      await asUser(owner.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"origin": "מיובא"}}' where id = $1`, [id]));
      expect(await customOf("leads", id)).toMatchObject({ origin: "מיובא" });
      for (const userId of [rep.id, owner.id]) {
        const again = await failure(asUser(userId, (q) => q(`update public.leads set custom_fields = '{"$merge": {"origin": "אחר"}}' where id = $1`, [id])));
        expect(again.hint).toBe("custom_field:read_only");
        expect((await failure(asUser(userId, (q) => q(`update public.leads set custom_fields = '{"$merge": {"origin": " "}}' where id = $1`, [id])))).hint).toBe(
          "custom_field:read_only",
        );
      }
    });

    it("the app and the database agree on what is empty", async () => {
      for (const value of [null, "", "   ", "\t \n", "x", 0, false, true, [], ["א"], " a "]) {
        const db = await asAdmin(async (q) => (await q<{ e: boolean }>("select app.custom_value_empty($1::jsonb) as e", [JSON.stringify(value)])).rows[0].e);
        expect(db, JSON.stringify(value)).toBe(isEmptyCustomValue(value));
      }
    });

    it("0 and false are values, not empty", async () => {
      await define(org, "lead", "ro_num", "number", { readOnly: true });
      await define(org, "lead", "ro_flag", "checkbox", { readOnly: true });
      const id = await lead(rep.id, { ro_num: 0, ro_flag: false, vip: null, tier: null });
      expect((await failure(asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"ro_num": 1}}' where id = $1`, [id])))).hint).toBe(
        "custom_field:read_only",
      );
      expect((await failure(asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"ro_flag": true}}' where id = $1`, [id])))).hint).toBe(
        "custom_field:read_only",
      );
      // an empty one of the same fields is filled once
      const other = await lead(rep.id, {});
      await asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"ro_num": 0}}' where id = $1`, [other]));
      expect((await failure(asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"ro_num": null}}' where id = $1`, [other])))).hint).toBe(
        "custom_field:read_only",
      );
    });

    it("no override: switching read-only off is a settings change the audit log records", async () => {
      const id = await lead(rep.id, { origin: "ישן" });
      await setField(owner.id, "origin", "is_read_only = false");
      await asUser(owner.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"origin": "חדש"}}' where id = $1`, [id]));
      await setField(owner.id, "origin", "is_read_only = true");
      const entries = await asAdmin(async (q) =>
        (
          await q<{ actor_id: string; changes: Record<string, { old: unknown; new: unknown }> }>(
            "select actor_id, changes from public.audit_log where organization_id = $1 and entity_type = 'field_definitions' and changes ? 'is_read_only' order by id",
            [org],
          )
        ).rows,
      );
      expect(entries.slice(-2).map((e) => [e.actor_id, e.changes.is_read_only])).toEqual([
        [owner.id, { old: true, new: false }],
        [owner.id, { old: false, new: true }],
      ]);
      expect(await customOf("leads", id)).toMatchObject({ origin: "חדש" });
    });

    it("an automation that writes a custom field follows the fill-once rule (AUT-01; the behaviour is tested in 129)", async () => {
      const defs = await asAdmin(async (q) =>
        (await q<{ def: string }>("select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'run_automation_actions'")).rows,
      );
      expect(defs.length).toBeGreaterThan(0);
      for (const { def } of defs) {
        if (!def.includes("custom_fields")) continue;
        // the set_field step reads the field's read-only flag and refuses changing a filled value
        expect(def).toContain("is_read_only");
        expect(def).toContain("app.custom_value_empty(v_record -> 'custom_fields' -> v_key)");
        expect(def).toContain("'the field is read-only'");
      }
    });

    it("a merge fills a missing value from the duplicate and never overwrites a kept one", async () => {
      const keep = await lead(owner.id, { origin: "שמור" });
      const dup = await lead(owner.id, { origin: "כפול" });
      await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep, dup]));
      expect(await customOf("leads", keep)).toMatchObject({ origin: "שמור" });
      const keep2 = await lead(owner.id, {});
      const dup2 = await lead(owner.id, { origin: "מהכפול" });
      await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep2, dup2]));
      expect(await customOf("leads", keep2)).toMatchObject({ origin: "מהכפול" });
    });

    it("server paths may still set it", async () => {
      const id = await lead(rep.id, { origin: "פייסבוק" });
      await asAdmin((q) => q(`update public.leads set custom_fields = custom_fields || '{"origin": "תיקון"}' where id = $1`, [id]));
      expect(await customOf("leads", id)).toMatchObject({ origin: "תיקון" });
    });
  });

  describe("unique", () => {
    it("refuses a second live record with the same value, compared normalized, for every person", async () => {
      await lead(owner.id, { ext: "  Abc-1 ", tel2: "050-1234567", num: 3 });
      const again = await failure(lead(rep.id, { ext: "abc-1" }));
      expect(again).toMatchObject({ code: "23505", hint: "custom_field:unique", detail: "מזהה חיצוני" });
      expect((await failure(lead(rep.id, { tel2: "+972 50 123 4567" }))).hint).toBe("custom_field:unique");
      expect((await failure(lead(rep.id, { num: 3.0 }))).hint).toBe("custom_field:unique");
      // another value, another business, another record type, an empty value: fine
      await lead(rep.id, { ext: "abc-2", num: 4, tel2: "050-7654321" });
      await lead(other.id, { ext: "abc-1" }, otherOrg);
      await asUser(rep.id, (q) => q(`insert into public.contacts (organization_id, first_name, custom_fields) values ($1, 'א', '{"ext": "abc-1"}')`, [org]));
      await lead(rep.id, { ext: "   " });
      await lead(rep.id, { ext: "" });
    });

    it("an update into a taken value is refused; clearing frees the value", async () => {
      const id = await lead(rep.id, { ext: "upd-1" });
      await lead(rep.id, { ext: "upd-2" });
      expect((await failure(asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"ext": "UPD-2"}}' where id = $1`, [id])))).hint).toBe(
        "custom_field:unique",
      );
      // clearing frees the value
      await asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"ext": null}}' where id = $1`, [id]));
      await asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"ext": "upd-1"}}' where id = $1`, [id]));
    });

    it("urls compare scheme and host without case and http = https, the path with its case", async () => {
      await define(org, "lead", "site", "url", { unique: true });
      await lead(rep.id, { site: "https://Example.com/Page/" });
      expect((await failure(lead(rep.id, { site: "http://EXAMPLE.com/Page" }))).hint).toBe("custom_field:unique");
      await lead(rep.id, { site: "https://example.com/page" });
    });

    it("records in the recycle bin do not count; restoring one into a clash is allowed and marked, never stranded", async () => {
      const binned = await lead(owner.id, { ext: "bin-1" });
      await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [binned]));
      const holder = await lead(rep.id, { ext: "BIN-1" });
      await asUser(owner.id, (q) => q("update public.leads set deleted_at = null where id = $1", [binned]));
      expect(await clashes(owner.id, "lead", [binned])).toEqual([{ record_id: binned, field_key: "ext", field_label: "מזהה חיצוני", other_id: holder }]);
      // editing it without touching the value is fine
      await asUser(owner.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"note": "שוחזר"}}' where id = $1`, [binned]));
    });

    it("an import that writes two equal values in one statement is refused", async () => {
      const job = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows) values ($1, 'lead', 'f.csv', 'skip', 2) returning id",
            [org],
          )
        ).rows[0].id,
      );
      const statusId = await asAdmin(async (q) => (await q("select id from public.lead_statuses where organization_id = $1 and is_default", [org])).rows[0].id);
      const error = await failure(
        asUser(owner.id, (q) =>
          q(
            `insert into public.leads (organization_id, status_id, full_name, import_job_id, custom_fields)
             values ($1, $2, 'א', $3, '{"ext": "imp-1"}'), ($1, $2, 'ב', $3, '{"ext": "Imp-1"}')`,
            [org, statusId, job],
          ),
        ),
      );
      expect(error.hint).toBe("custom_field:unique");
    });

    it("lead conversion carries a taken value and marks the new contact; a merge that moves the duplicate's value is not refused", async () => {
      const existing = await asUser(rep.id, async (q) =>
        (await q<{ id: string }>(`insert into public.contacts (organization_id, first_name, custom_fields) values ($1, 'קיים', '{"ext": "conv-1"}') returning id`, [org])).rows[0].id,
      );
      const toConvert = await lead(rep.id, { ext: "Conv-1" });
      const result = await asUser(rep.id, async (q) => (await q<{ r: { contact_id: string } }>("select public.convert_lead($1) as r", [toConvert])).rows[0].r);
      expect(await customOf("contacts", result.contact_id)).toMatchObject({ ext: "Conv-1" });
      expect(await clashes(rep.id, "contact", [result.contact_id])).toEqual([
        { record_id: result.contact_id, field_key: "ext", field_label: "מזהה חיצוני", other_id: existing },
      ]);
      // the carried value is not recorded: the existing contact keeps it, and editing the new one is fine
      await asUser(rep.id, (q) => q(`update public.contacts set first_name = 'חדש' where id = $1`, [result.contact_id]));

      const keep = await lead(owner.id, { note: "נשאר" });
      const dup = await lead(owner.id, { ext: "merge-1" });
      await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep, dup]));
      expect(await customOf("leads", keep)).toMatchObject({ ext: "merge-1", note: "נשאר" });
    });

    it("public forms are not refused (the inquiry is kept, and nothing is told to the visitor)", async () => {
      const form = await asUser(owner.id, async (q) =>
        (await q<{ token: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס') returning token", [org])).rows[0].token,
      );
      await asUser(owner.id, (q) =>
        q("update public.forms set fields = $2 where organization_id = $1 and token = $3", [
          org,
          JSON.stringify([{ key: "full_name", required: true }, { key: "phone", required: true }, { key: "cf:ext", required: false }]),
          form,
        ]),
      );
      const holder = await lead(rep.id, { ext: "form-1" });
      const submit = (phone: string) =>
        asService(async (q) =>
          (await q<{ r: { status: string; lead_id: string } }>("select public.intake_submit($1, 'form', $2) as r", [form, JSON.stringify({ full_name: "פונה", phone, custom: { ext: "form-1" } })]))
            .rows[0].r,
        );
      const first = await submit("052-9900001");
      expect(first.status).toBe("accepted");
      expect(await customOf("leads", first.lead_id)).toMatchObject({ ext: "form-1" });
      // the older clash does not block editing another field; a new value is checked (abc-1 is taken)
      await asUser(owner.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"note": "טופל"}}' where id = $1`, [first.lead_id]));
      expect(
        (await failure(asUser(owner.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"ext": "ABC-1"}}' where id = $1`, [first.lead_id])))).hint,
      ).toBe("custom_field:unique");
      // the mark: field and existing record, for the lead card and the waiting screen
      const marks = await clashes(owner.id, "lead", [first.lead_id]);
      expect(marks).toEqual([{ record_id: first.lead_id, field_key: "ext", field_label: "מזהה חיצוני", other_id: holder }]);
      // a second form lead with the same value is accepted too
      const again = await submit("052-9900002");
      expect(again.status).toBe("accepted");
      // conversion of the form lead is allowed; the clash carries over to the contact
      const converted = await asUser(owner.id, async (q) => (await q<{ r: { contact_id: string } }>("select public.convert_lead($1) as r", [first.lead_id])).rows[0].r);
      expect(await customOf("contacts", converted.contact_id)).toMatchObject({ ext: "form-1" });
      // restoring the form lead after a trip to the bin is allowed and keeps the mark
      await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [again.lead_id]));
      await asUser(owner.id, (q) => q("update public.leads set deleted_at = null where id = $1", [again.lead_id]));
      expect((await clashes(owner.id, "lead", [again.lead_id])).map((m) => m.other_id)).toEqual([holder]);
    });

    it("a public-form lead records a free value (a person who types it later is refused) and keeps a taken one, marked", async () => {
      const form = await asUser(owner.id, async (q) =>
        (
          await q<{ token: string }>("insert into public.forms (organization_id, name, fields) values ($1, 'טופס ייחודי', $2) returning token", [
            org,
            JSON.stringify([{ key: "full_name", required: true }, { key: "phone", required: true }, { key: "cf:ext", required: false }]),
          ])
        ).rows[0].token,
      );
      const submit = (phone: string, ext: string) =>
        asService(async (q) =>
          (await q<{ r: { status: string; lead_id: string } }>("select public.intake_submit($1, 'form', $2) as r", [form, JSON.stringify({ full_name: "פונה", phone, custom: { ext } })]))
            .rows[0].r,
        );
      // (a) a free value is recorded
      const free = await submit("052-9910001", "Form-Free-1");
      expect(free.status).toBe("accepted");
      expect(await customOf("leads", free.lead_id)).toMatchObject({ ext: "Form-Free-1" });
      expect(await clashes(owner.id, "lead", [free.lead_id])).toEqual([]);
      expect(await failure(lead(rep.id, { ext: "  form-free-1 " }))).toMatchObject({ code: "23505", hint: "custom_field:unique", detail: "מזהה חיצוני" });
      const other = await lead(rep.id, { note: "אחר" });
      expect(
        (await failure(asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"ext": "FORM-FREE-1"}}' where id = $1`, [other])))).hint,
      ).toBe("custom_field:unique");
      // (b) a taken value is stored on the lead, unrecorded, and marked
      const holder = await lead(rep.id, { ext: "form-taken-1" });
      const taken = await submit("052-9910002", "FORM-TAKEN-1");
      expect(taken.status).toBe("accepted");
      expect(await customOf("leads", taken.lead_id)).toMatchObject({ ext: "FORM-TAKEN-1" });
      expect(await clashes(owner.id, "lead", [taken.lead_id])).toEqual([{ record_id: taken.lead_id, field_key: "ext", field_label: "מזהה חיצוני", other_id: holder }]);
      // (c) a person's transaction writing the same value at the same moment: the form waits, and is accepted when it wins
      // (an update of an existing record, so nothing but the value makes the form wait)
      const racer = await lead(rep.id, { note: "מתחרה" });
      const person = new Client({ connectionString: TEST_DB_URL });
      await person.connect();
      try {
        await person.query("begin");
        await person.query(`update public.leads set custom_fields = custom_fields || '{"ext": "form-race-1"}' where id = $1`, [racer]);
        const pending = submit("052-9910003", "Form-Race-1");
        await new Promise((resolve) => setTimeout(resolve, 200));
        await person.query("commit");
        const raced = await pending;
        expect(raced.status).toBe("accepted");
        expect(await customOf("leads", raced.lead_id)).toMatchObject({ ext: "Form-Race-1" });
        expect((await clashes(owner.id, "lead", [raced.lead_id])).map((m) => m.other_id)).toEqual([racer]);
      } finally {
        await person.end();
      }
    });

    it("turning unique on waits for records being written, and records written meanwhile wait for it", async () => {
      await define(org, "lead", "lk", "text");
      await define(org, "lead", "lk2", "text");
      await lead(rep.id, { lk: "lock-1", lk2: "lock-2" });
      const statusId = await defaultLeadStatus(org);
      const insert = (client: Client, custom: Record<string, string>) =>
        client.query(`insert into public.leads (organization_id, status_id, full_name, custom_fields) values ($1, $2, 'מקביל', $3)`, [org, statusId, JSON.stringify(custom)]);
      const turnOn = (client: Client, key: string) =>
        client.query("update public.field_definitions set is_unique = true where organization_id = $1 and object_type = 'lead' and key = $2", [org, key]);
      const settle = <T,>(promise: Promise<T>) => {
        const state = { done: false };
        const result = promise.then(
          () => {
            state.done = true;
            return null;
          },
          (error: DbError) => {
            state.done = true;
            return error;
          },
        );
        return { state, result };
      };
      const writer = new Client({ connectionString: TEST_DB_URL });
      const admin = new Client({ connectionString: TEST_DB_URL });
      await writer.connect();
      await admin.connect();
      try {
        // a record written before the switch commits is counted by it
        await writer.query("begin");
        await insert(writer, { lk: "LOCK-1" });
        await admin.query("begin");
        const on = settle(turnOn(admin, "lk"));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(on.state.done).toBe(false);
        await writer.query("commit");
        expect((await on.result)?.hint).toBe("custom_field:unique_existing");
        await admin.query("rollback");
        // a record written while the switch is open waits for it, and is then checked
        await admin.query("begin");
        await turnOn(admin, "lk2");
        await writer.query("begin");
        const write = settle(insert(writer, { lk2: " Lock-2" }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(write.state.done).toBe(false);
        await admin.query("commit");
        expect(await write.result).toBeNull();
        expect((await failure(writer.query("commit"))).hint).toBe("custom_field:unique");
      } finally {
        await writer.end();
        await admin.end();
      }
    });

    it("the mark names the other record only for those who may read it; nothing for outsiders", async () => {
      const visOrg = await createOrg(owner.id, "עסק פרטי");
      const seller = await addMember(visOrg, owner.id, "member");
      await define(visOrg, "lead", "ext", "text", { unique: true, label: "מזהה" });
      const ownersLead = await lead(owner.id, { ext: "vis-1" }, visOrg);
      await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [visOrg]));
      // the seller's lead got the same value through a path that does not refuse (restore)
      const sellers = await lead(seller.id, { ext: "other" }, visOrg);
      await asAdmin(async (q) => {
        await q("update public.leads set deleted_at = now() where id = $1", [sellers]);
        await q(`update public.leads set custom_fields = '{"ext": "vis-1"}' where id = $1`, [sellers]);
        await q("update public.leads set deleted_at = null where id = $1", [sellers]);
      });
      expect(await clashes(seller.id, "lead", [sellers], visOrg)).toEqual([{ record_id: sellers, field_key: "ext", field_label: "מזהה", other_id: null }]);
      expect((await clashes(owner.id, "lead", [sellers], visOrg))[0].other_id).toBe(ownersLead);
      // a record the caller cannot read is not answered at all; nor is anything for another business
      expect(await clashes(seller.id, "lead", [ownersLead], visOrg)).toEqual([]);
      expect(await clashes(other.id, "lead", [sellers], visOrg)).toEqual([]);
      expect((await failure(clashes(owner.id, "lead", Array.from({ length: 201 }, () => sellers), visOrg))).code).toBe("22023");
    });

    it("turning it on while records already share a value is refused with their number", async () => {
      await define(org, "lead", "later", "text");
      await lead(rep.id, { later: "same" });
      await lead(rep.id, { later: " SAME" });
      await lead(rep.id, { later: "other" });
      const error = await failure(setField(owner.id, "later", "is_unique = true"));
      expect(error).toMatchObject({ hint: "custom_field:unique_existing", detail: "2" });
      await define(org, "lead", "later_ok", "text");
      await lead(rep.id, { later_ok: "one" });
      expect((await setField(owner.id, "later_ok", "is_unique = true")).rowCount).toBe(1);
      // the values were recorded when it was turned on
      expect((await failure(lead(rep.id, { later_ok: "ONE" }))).hint).toBe("custom_field:unique");
    });

    it("only owners and admins may turn it on; others get 42501 or 0 rows, never the count", async () => {
      // "later" still has two leads that share a value
      const member = await setField(rep.id, "later", "is_unique = true");
      expect(member.rowCount).toBe(0);
      const outsider = await asUser(other.id, (q) =>
        q("update public.field_definitions set is_unique = true where organization_id = $1 and key = 'later' returning id", [org]),
      );
      expect(outsider.rowCount).toBe(0);
      const insertAs = (userId: string) =>
        asUser(userId, (q) =>
          q("insert into public.field_definitions (organization_id, object_type, key, label, field_type, is_unique) values ($1, 'contact', 'later', 'x', 'text', true)", [org]),
        );
      // contacts with a shared value under the key the insert names (left by a server path)
      await asAdmin((q) => q(`insert into public.contacts (organization_id, first_name, custom_fields) values ($1, 'א', '{"later": "a"}'), ($1, 'ב', '{"later": "a"}')`, [org]));
      for (const userId of [rep.id, other.id]) {
        const error = await failure(insertAs(userId));
        expect(error.code).toBe("42501");
        expect(error.hint).toBeUndefined();
      }
    });

    it("a hidden field is not enforced; switching unique off, hiding or deleting forgets the values; showing again is checked", async () => {
      await define(org, "lead", "flip", "text", { unique: true });
      const first = await lead(rep.id, { flip: "v" });
      expect((await failure(lead(rep.id, { flip: "v" }))).hint).toBe("custom_field:unique");
      // hidden: not enforced
      await setField(owner.id, "flip", "is_active = false");
      const second = await lead(rep.id, { flip: "v" });
      expect((await failure(setField(owner.id, "flip", "is_active = true"))).hint).toBe("custom_field:unique_existing");
      await asAdmin((q) => q(`update public.leads set custom_fields = custom_fields - 'flip' where id = $1`, [second]));
      expect((await setField(owner.id, "flip", "is_active = true")).rowCount).toBe(1);
      // off: two equal values are fine
      await setField(owner.id, "flip", "is_unique = false");
      await lead(rep.id, { flip: "v" });
      const forgotten = await asAdmin(async (q) =>
        (
          await q(
            "select count(*)::int as n from app.custom_unique_values v join public.field_definitions f on f.id = v.field_id where f.organization_id = $1 and f.key = 'flip' and v.norm_value is not null",
            [org],
          )
        ).rows[0].n,
      );
      expect(forgotten).toBe(0);
      expect(first).toBeTruthy();
      // a deleted unique field leaves no values behind
      await define(org, "lead", "gone", "text", { unique: true });
      await lead(rep.id, { gone: "secret" });
      const goneId = await asAdmin(async (q) => (await q("select id from public.field_definitions where organization_id = $1 and key = 'gone'", [org])).rows[0].id as string);
      const rowsOf = () => asAdmin(async (q) => (await q("select count(*)::int as n from app.custom_unique_values where field_id = $1", [goneId])).rows[0].n);
      expect(await rowsOf()).toBe(1);
      await asUser(owner.id, (q) => q("delete from public.field_definitions where organization_id = $1 and key = 'gone'", [org]));
      const left = await rowsOf();
      expect(left).toBe(0);
    });

    it("a record in the bin or purged keeps no value in the index", async () => {
      const id = await lead(owner.id, { ext: "purge-1" });
      const valueOf = () =>
        asAdmin(
          async (q) =>
            (
              await q(
                "select v.norm_value from app.custom_unique_values v join public.field_definitions f on f.id = v.field_id where v.record_id = $1 and f.key = 'ext'",
                [id],
              )
            ).rows[0]?.norm_value ?? null,
        );
      expect(await valueOf()).toBe("purge-1");
      await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [id]));
      expect(await valueOf()).toBeNull();
      await asUser(owner.id, (q) => q("update public.leads set deleted_at = null where id = $1", [id]));
      expect(await valueOf()).toBe("purge-1");
      await asAdmin((q) => q("delete from public.leads where id = $1", [id]));
      expect(await valueOf()).toBeNull();
      await lead(owner.id, { ext: "purge-1" });
    });

    it("two transactions writing the same value at once: the second waits for the first and is refused", async () => {
      // updates of two existing records: nothing else makes them wait for each other but the unique constraint
      const a = await lead(rep.id, { note: "a" });
      const b = await lead(rep.id, { note: "b" });
      const update = `update public.leads set custom_fields = custom_fields || '{"ext": "race-1"}' where id = $1`;
      const first = new Client({ connectionString: TEST_DB_URL });
      const second = new Client({ connectionString: TEST_DB_URL });
      await first.connect();
      await second.connect();
      try {
        await first.query("begin");
        await first.query(update, [a]);
        // run the deferred checks now; the first transaction stays open
        await first.query("set constraints all immediate");
        await second.query("begin");
        await second.query(update, [b]);
        const pending = second.query("set constraints all immediate").then(
          () => null,
          (error: DbError) => error,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await first.query("commit");
        const error = await pending;
        // the constraint answers (a bare 23505 on custom_unique_values_value), which the app maps too
        expect(error?.code).toBe("23505");
        await second.query("rollback");
      } finally {
        await first.end();
        await second.end();
      }
      expect(await customOf("leads", a)).toMatchObject({ ext: "race-1" });
      expect(await customOf("leads", b)).toEqual({ note: "b", tier: "רגיל", vip: true });
    });
  });
});
