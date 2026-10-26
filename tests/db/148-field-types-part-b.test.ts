import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MIGRATIONS_DIR, migrationFile, rerunClosure, staleRestores } from "./rerun";

// review F5: 020905 alone, run again, must keep 020910's body of app.custom_field_file_drop (and leave every other function
// it defines as the fresh build made it, which staleRestores checks)
const PART_B = migrationFile("_field_types_part_b.sql");

afterAll(closePool);

type U = { id: string };
type DbError = { code?: string; hint?: string; message: string };
const failure = async (promise: Promise<unknown>) => (await pgError(promise)) as DbError;

// FLD-06 part B: address, record link and file fields.
describe("new custom field types (FLD-06 part B)", () => {
  let owner: U, rep: U, rep2: U, viewer: U, stranger: U;
  let org: string, otherOrg: string;

  const define = (o: string, object: string, key: string, type: string, extra: { target?: string; label?: string; readOnly?: boolean } = {}) =>
    asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.field_definitions (organization_id, object_type, key, label, field_type, link_target, is_read_only)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [o, object, key, extra.label ?? key, type, extra.target ?? null, extra.readOnly ?? false],
        )
      ).rows[0].id,
    );
  const valueOk = (type: string, value: unknown) =>
    asAdmin(async (q) => (await q<{ ok: boolean }>("select app.custom_value_ok($1, '[]'::jsonb, $2::jsonb) as ok", [type, JSON.stringify(value)])).rows[0].ok);
  const fieldsOf = (table: string, id: string) =>
    asAdmin(async (q) => (await q<{ c: Record<string, unknown> }>(`select custom_fields as c from public.${table} where id = $1`, [id])).rows[0].c ?? {});
  const setField = (userId: string, table: string, id: string, patch: Record<string, unknown>) =>
    asUser(userId, (q) => q(`update public.${table} set custom_fields = $2 where id = $1 returning id`, [id, JSON.stringify({ $merge: patch })]));
  const contact = (userId: string, o: string, name: string, extra: Record<string, unknown> = {}) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id, custom_fields) values ($1, $2, $3, $4) returning id", [
          o,
          name,
          extra.owner_id ?? userId,
          JSON.stringify(extra.custom_fields ?? {}),
        ])
      ).rows[0].id,
    );
  // a field file: the row, the object Storage measured, then the confirmation
  const upload = async (userId: string, leadId: string, key: string, opts: { confirm?: boolean; o?: string } = {}) => {
    const file = await asUser(userId, async (q) =>
      (
        await q<{ id: string; storage_path: string }>(
          "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes, custom_field_key) values ($1, $2, 'חוזה.pdf', 'application/pdf', 100, $3) returning id, storage_path",
          [opts.o ?? org, leadId, key],
        )
      ).rows[0],
    );
    if (opts.confirm !== false) {
      await asUser(userId, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [file.storage_path]));
      await asAdmin((q) => q("update storage.objects set metadata = '{\"size\": 100, \"mimetype\": \"application/pdf\"}' where bucket_id = 'record-files' and name = $1", [file.storage_path]));
      const r = await asUser(userId, async (q) => (await q<{ r: { ok: boolean } }>("select public.confirm_file_upload($1, $2) as r", [opts.o ?? org, file.id])).rows[0].r);
      expect(r.ok).toBe(true);
    }
    return file;
  };
  const fileExists = (id: string) => asAdmin((q) => count(q, "select 1 from public.files where id = $1", [id]));
  const orphaned = (path: string) => asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [path]));

  beforeAll(async () => {
    owner = await createUser("fld06b-owner");
    org = await createOrg(owner.id, "עסק שדות ב");
    rep = await addMember(org, owner.id, "member", "fld06b-rep");
    rep2 = await addMember(org, owner.id, "member", "fld06b-rep2");
    viewer = await addMember(org, owner.id, "viewer", "fld06b-viewer");
    stranger = await createUser("fld06b-stranger");
    otherOrg = await createOrg(stranger.id, "עסק זר");
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    await define(org, "lead", "site", "address");
    await define(org, "lead", "client", "record_link", { target: "contact", label: "לקוח" });
    await define(org, "lead", "referrer", "record_link", { target: "lead" });
    await define(org, "lead", "contract", "file", { label: "חוזה" });
    await define(org, "lead", "scan", "file");
    await define(org, "lead", "plain", "text");
    await define(org, "contact", "client", "record_link", { target: "contact", label: "לקוח" });
    await define(org, "contact", "contract", "file", { label: "חוזה" });
  });

  it("the database checks each new type's value as the app does", async () => {
    expect(await valueOk("address", "הרצל 1, תל אביב")).toBe(true);
    expect(await valueOk("address", "x".repeat(500))).toBe(true);
    expect(await valueOk("address", "x".repeat(501))).toBe(false);
    expect(await valueOk("address", "שורה\nשנייה")).toBe(false);
    expect(await valueOk("address", 5)).toBe(false);
    for (const type of ["record_link", "file"]) {
      expect(await valueOk(type, "0b7c7c64-34c4-4b4e-9b62-0d9f8a3c1e11"), type).toBe(true);
      expect(await valueOk(type, "not-a-uuid"), type).toBe(false);
      expect(await valueOk(type, 7), type).toBe(false);
      expect(await valueOk(type, null), type).toBe(true);
    }
  });

  it("a record link names its target type; the type and target never change; no default", async () => {
    expect((await failure(define(org, "lead", "no_target", "record_link"))).code).toBe("23514");
    expect((await failure(define(org, "lead", "bad_target", "record_link", { target: "task" }))).code).toBe("23514");
    expect((await failure(define(org, "lead", "text_target", "text", { target: "lead" }))).code).toBe("23514");
    const id = await define(org, "deal", "partner", "record_link", { target: "company" });
    const change = (sql: string) => failure(asUser(owner.id, (q) => q(`update public.field_definitions set ${sql} where id = $1`, [id])));
    expect((await change("link_target = 'contact'")).hint).toBe("custom_field:type_locked");
    expect((await change("field_type = 'text', link_target = null")).hint).toBe("custom_field:type_locked");
    expect((await change(`default_value = '"0b7c7c64-34c4-4b4e-9b62-0d9f8a3c1e11"'`)).hint).toBe("custom_field:default");
    const text = await define(org, "deal", "was_text", "text");
    expect((await failure(asUser(owner.id, (q) => q("update public.field_definitions set field_type = 'file' where id = $1", [text])))).hint).toBe(
      "custom_field:type_locked",
    );
    // a label change is fine
    await asUser(owner.id, (q) => q("update public.field_definitions set label = 'שותף' where id = $1", [id]));
  });

  it("an address is one line", async () => {
    const lead = await insertLead(rep.id, org, { owner_id: rep.id, custom_fields: JSON.stringify({ site: "הרצל 1, תל אביב" }) });
    expect((await fieldsOf("leads", lead)).site).toBe("הרצל 1, תל אביב");
    expect((await failure(setField(rep.id, "leads", lead, { site: "א\nב" }))).hint).toBe("custom_field:invalid");
  });

  it("a record link must be a live record of the business that the writer reads", async () => {
    const mine = await contact(rep.id, org, "שלי");
    const theirs = await contact(rep2.id, org, "של אחר");
    const foreign = await contact(stranger.id, otherOrg, "זר");
    const binned = await contact(rep.id, org, "בסל");
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [binned]));
    const lead = await insertLead(rep.id, org, { owner_id: rep.id, custom_fields: JSON.stringify({ client: mine }) });
    expect((await fieldsOf("leads", lead)).client).toBe(mine);
    for (const [target, why] of [
      [foreign, "another business"],
      [theirs, "a record the writer cannot read ('own' visibility)"],
      [binned, "a record in the bin"],
      ["0b7c7c64-34c4-4b4e-9b62-0d9f8a3c1e11", "no record at all"],
    ]) {
      expect((await failure(setField(rep.id, "leads", lead, { client: target }))).hint, why).toBe("custom_field:record_link");
    }
    // a lead id in a contact link is not a contact
    expect((await failure(setField(rep.id, "leads", lead, { client: lead }))).hint).toBe("custom_field:record_link");
    // the owner reads everything, so the owner may link rep2's contact
    await setField(owner.id, "leads", lead, { client: theirs });
    // the rep can still edit another field of the lead whose link they cannot read
    await setField(rep.id, "leads", lead, { plain: "עדכון" });
    expect((await fieldsOf("leads", lead)).client).toBe(theirs);
    // and may clear it
    await setField(rep.id, "leads", lead, { client: null });
    expect((await fieldsOf("leads", lead)).client).toBeUndefined();
  });

  it("purging the target empties the link; the recycle bin does not", async () => {
    const target = await contact(owner.id, org, "יעד");
    const other = await contact(owner.id, org, "אחר");
    const lead = await insertLead(owner.id, org, { custom_fields: JSON.stringify({ client: target, plain: "נשאר" }) });
    const keepLead = await insertLead(owner.id, org, { custom_fields: JSON.stringify({ client: other }) });
    const peer = await contact(owner.id, org, "עמית", { custom_fields: { client: target } });
    // a business that holds the same id as text is never touched
    await define(otherOrg, "lead", "client", "text");
    const foreignLead = await insertLead(stranger.id, otherOrg, { custom_fields: JSON.stringify({ client: target }) });
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [target]));
    expect((await fieldsOf("leads", lead)).client).toBe(target);
    await asUser(owner.id, (q) => q("delete from public.contacts where id = $1", [target]));
    expect(await fieldsOf("leads", lead)).toEqual({ plain: "נשאר" });
    expect((await fieldsOf("contacts", peer)).client).toBeUndefined();
    expect((await fieldsOf("leads", keepLead)).client).toBe(other);
    expect((await fieldsOf("leads", foreignLead)).client).toBe(target);
  });

  it("a lead links to a lead; purging many at once empties every link", async () => {
    const a = await insertLead(owner.id, org, { full_name: "א" });
    const b = await insertLead(owner.id, org, { full_name: "ב" });
    const c = await insertLead(owner.id, org, { full_name: "ג", custom_fields: JSON.stringify({ referrer: a }) });
    const d = await insertLead(owner.id, org, { full_name: "ד", custom_fields: JSON.stringify({ referrer: b }) });
    await asUser(owner.id, async (q) => {
      await q("update public.leads set deleted_at = now() where id = any($1)", [[a, b]]);
      await q("delete from public.leads where id = any($1)", [[a, b]]);
    });
    expect((await fieldsOf("leads", c)).referrer).toBeUndefined();
    expect((await fieldsOf("leads", d)).referrer).toBeUndefined();
  });

  // FLD-06 part B follow-up (owner, 26 October 2026): a purge that empties a link leaves one system entry on the linking record
  const linkEntries = (column: string, id: string) =>
    asAdmin(
      async (q) =>
        (
          await q<{ id: string; body: string; metadata: Record<string, unknown>; created_by: string | null }>(
            `select id, body, metadata, created_by from public.activities
              where ${column} = $1 and type = 'system' and metadata ->> 'kind' = 'record_link_removed' order by created_at`,
            [id],
          )
        ).rows,
    );

  it("follow-up: a purge that empties a link writes one entry on each linking record, with the type and no name", async () => {
    const target = await contact(owner.id, org, "שם-שלא-יופיע");
    const lead = await insertLead(owner.id, org, { full_name: "מקשר", custom_fields: JSON.stringify({ client: target }) });
    const peer = await contact(owner.id, org, "עמית קישור", { custom_fields: { client: target } });
    const untouched = await insertLead(owner.id, org, { full_name: "בלי קישור" });
    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [target]);
      expect(await linkEntries("lead_id", lead)).toEqual([]);
      await q("delete from public.contacts where id = $1", [target]);
    });
    const entries = await linkEntries("lead_id", lead);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("הקישור ל-איש קשר הוסר: הרשומה נמחקה");
    expect(entries[0].metadata).toEqual({ kind: "record_link_removed", field_key: "client", target_type: "contact" });
    expect(entries[0].created_by).toBeNull();
    expect(JSON.stringify(entries)).not.toContain("שם-שלא-יופיע");
    expect(JSON.stringify(entries)).not.toContain(target);
    expect(await linkEntries("contact_id", peer)).toHaveLength(1);
    expect(await linkEntries("lead_id", untouched)).toEqual([]);
  });

  it("follow-up: a deal's link to a company gets its entry on the deal", async () => {
    await define(org, "deal", "partner_co", "record_link", { target: "company" });
    const company = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברה למחיקה') returning id", [org])).rows[0].id,
    );
    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, custom_fields) values ($1, 'עסקה מקשרת', $2, $3, $4) returning id",
          [org, pipelineId, stages[0].id, JSON.stringify({ partner_co: company })],
        )
      ).rows[0].id,
    );
    await asUser(owner.id, async (q) => {
      await q("update public.companies set deleted_at = now() where id = $1", [company]);
      await q("delete from public.companies where id = $1", [company]);
    });
    expect((await fieldsOf("deals", deal)).partner_co).toBeUndefined();
    const entries = await linkEntries("deal_id", deal);
    expect(entries.map((e) => e.body)).toEqual(["הקישור ל-חברה הוסר: הרשומה נמחקה"]);
    expect(entries[0].metadata.target_type).toBe("company");
  });

  it("follow-up: nobody but the server writes, changes or deletes such an entry, owners included", async () => {
    const target = await contact(owner.id, org, "יעד שמירה");
    const lead = await insertLead(owner.id, org, { full_name: "מקשר שמור", custom_fields: JSON.stringify({ client: target }) });
    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [target]);
      await q("delete from public.contacts where id = $1", [target]);
    });
    const [entry] = await linkEntries("lead_id", lead);
    for (const sql of [
      "update public.activities set body = 'אחר' where id = $1",
      "update public.activities set is_pinned = true where id = $1",
      "update public.activities set metadata = '{}' where id = $1",
      "delete from public.activities where id = $1",
    ]) {
      expect((await failure(asUser(owner.id, (q) => q(sql, [entry.id])))).hint, sql).toBe("activity:record_link_entry");
    }
    expect(
      (
        await failure(
          asUser(owner.id, (q) =>
            q("insert into public.activities (organization_id, type, lead_id, body, metadata) values ($1, 'note', $2, 'מזויף', $3)", [
              org,
              lead,
              JSON.stringify({ kind: "record_link_removed", target_type: "contact" }),
            ]),
          ),
        )
      ).hint,
    ).toBe("activity:record_link_entry");
    // a person's note may not take that kind later either
    const note = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, lead_id, body) values ($1, 'note', $2, 'הערה') returning id", [org, lead])).rows[0].id,
    );
    expect((await failure(asUser(owner.id, (q) => q(`update public.activities set metadata = '{"kind": "record_link_removed"}' where id = $1`, [note]))))
      .hint).toBe("activity:record_link_entry");
    expect(await linkEntries("lead_id", lead)).toHaveLength(1);
    // the record's own purge takes it (server path)
    await asUser(owner.id, async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [lead]);
      await q("delete from public.leads where id = $1", [lead]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where id = $1", [entry.id]))).toBe(0);
  });

  it("a field's file: only on a file field of a record the person edits; the value must be that confirmed file", async () => {
    const lead = await insertLead(rep.id, org, { owner_id: rep.id });
    // not a file field, an unknown field, a note
    expect((await failure(upload(rep.id, lead, "plain", { confirm: false }))).hint).toBe("file:field");
    expect((await failure(upload(rep.id, lead, "nope", { confirm: false }))).hint).toBe("file:field");
    // a viewer, and a member who cannot read the lead
    expect((await failure(upload(viewer.id, lead, "contract", { confirm: false }))).code).toBe("42501");
    expect((await failure(upload(rep2.id, lead, "contract", { confirm: false }))).code).toBe("42501");
    // a waiting upload is not a value yet
    const waiting = await upload(rep.id, lead, "contract", { confirm: false });
    expect((await failure(setField(rep.id, "leads", lead, { contract: waiting.id }))).hint).toBe("custom_field:file");
    const file = await upload(rep.id, lead, "contract");
    // another field's file, another record's file
    expect((await failure(setField(rep.id, "leads", lead, { scan: file.id }))).hint).toBe("custom_field:file");
    const other = await insertLead(rep.id, org, { owner_id: rep.id });
    expect((await failure(setField(rep.id, "leads", other, { contract: file.id }))).hint).toBe("custom_field:file");
    expect((await failure(insertLead(rep.id, org, { owner_id: rep.id, custom_fields: JSON.stringify({ contract: file.id }) }))).hint).toBe(
      "custom_field:file",
    );
    await setField(rep.id, "leads", lead, { contract: file.id });
    expect((await fieldsOf("leads", lead)).contract).toBe(file.id);
    // reading follows the lead: rep2 ('own' visibility) and an outsider see nothing
    expect(await asUser(rep2.id, (q) => count(q, "select 1 from public.files where id = $1", [file.id]))).toBe(0);
    expect(await asUser(stranger.id, (q) => count(q, "select 1 from public.files where id = $1", [file.id]))).toBe(0);
    expect(await asUser(rep.id, (q) => count(q, "select 1 from public.files where id = $1", [file.id]))).toBe(1);
    // a field's file has no versions
    expect(
      (
        await failure(
          asUser(rep.id, (q) =>
            q("insert into public.files (organization_id, lead_id, name, mime_type, size_bytes, previous_id) values ($1, $2, 'v2.pdf', 'application/pdf', 1, $3)", [
              org,
              lead,
              file.id,
            ]),
          ),
        )
      ).hint,
    ).toBe("file:field");
  });

  it("the current file is not removed directly; replacing or clearing the value releases the old file", async () => {
    const lead = await insertLead(rep.id, org, { owner_id: rep.id });
    const first = await upload(rep.id, lead, "contract");
    await setField(rep.id, "leads", lead, { contract: first.id });
    // neither the uploader nor an admin removes the row or the object of the current file
    expect((await failure(asUser(rep.id, (q) => q("delete from public.files where id = $1", [first.id])))).hint).toBe("file:field");
    expect((await failure(asUser(owner.id, (q) => q("delete from public.files where id = $1", [first.id])))).hint).toBe("file:field");
    expect((await asUser(rep.id, (q) => q("delete from storage.objects where name = $1", [first.storage_path]))).rowCount).toBe(0);
    // replaced: the old file goes, its object waits for the cleanup
    const second = await upload(rep.id, lead, "contract");
    await setField(rep.id, "leads", lead, { contract: second.id });
    expect(await fileExists(first.id)).toBe(0);
    expect(await orphaned(first.storage_path)).toBe(1);
    expect(await fileExists(second.id)).toBe(1);
    // cleared
    await setField(rep.id, "leads", lead, { contract: null });
    expect(await fileExists(second.id)).toBe(0);
    expect(await orphaned(second.storage_path)).toBe(1);
    // an upload never set as the value may be removed by its uploader
    const unused = await upload(rep.id, lead, "contract");
    expect((await asUser(rep.id, (q) => q("delete from public.files where id = $1", [unused.id]))).rowCount).toBe(1);
  });

  it("a read-only file field is locked once filled", async () => {
    await define(org, "lead", "signed", "file", { readOnly: true });
    const lead = await insertLead(rep.id, org, { owner_id: rep.id });
    const file = await upload(rep.id, lead, "signed");
    await setField(rep.id, "leads", lead, { signed: file.id });
    const next = await upload(rep.id, lead, "signed");
    expect((await failure(setField(rep.id, "leads", lead, { signed: next.id }))).hint).toBe("custom_field:read_only");
    expect((await failure(setField(rep.id, "leads", lead, { signed: null }))).hint).toBe("custom_field:read_only");
  });

  it("purging the record takes its field files; deleting the field releases its files", async () => {
    const lead = await insertLead(owner.id, org);
    const file = await upload(owner.id, lead, "scan");
    await setField(owner.id, "leads", lead, { scan: file.id });
    await asUser(owner.id, async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [lead]);
    });
    expect(await fileExists(file.id)).toBe(1);
    await asUser(owner.id, (q) => q("delete from public.leads where id = $1", [lead]));
    expect(await fileExists(file.id)).toBe(0);
    expect(await orphaned(file.storage_path)).toBe(1);
    // the privacy erasure erases the file's entries with the record's
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'leads', $2)", [org, lead]));
    const entries = await asAdmin(async (q) => (await q<{ c: unknown }>("select changes as c from public.audit_log where entity_type = 'files' and entity_id = $1", [file.id])).rows);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.c).toEqual({ erased: true });

    const fieldId = await define(org, "lead", "temp_file", "file");
    const lead2 = await insertLead(owner.id, org);
    const tmp = await upload(owner.id, lead2, "temp_file");
    await setField(owner.id, "leads", lead2, { temp_file: tmp.id });
    await asUser(owner.id, (q) => q("delete from public.field_definitions where id = $1", [fieldId]));
    expect(await fileExists(tmp.id)).toBe(0);
  });

  it("the storage quota and the waiting cap apply to field files", async () => {
    const qOrg = await createOrg(owner.id, "עסק מכסה");
    await define(qOrg, "lead", "contract", "file");
    const lead = await insertLead(owner.id, qOrg);
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{\"storage_gb\": 0.00001}' where organization_id = $1", [qOrg]));
    const add = (size: number) =>
      asUser(owner.id, (q) =>
        q("insert into public.files (organization_id, lead_id, name, mime_type, size_bytes, custom_field_key) values ($1, $2, 'a.pdf', 'application/pdf', $3, 'contract')", [
          qOrg,
          lead,
          size,
        ]),
      );
    expect((await failure(add(20_000))).hint).toBe("limit:storage_gb");
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{}' where organization_id = $1", [qOrg]));
    for (let i = 0; i < 20; i += 1) await add(1);
    expect((await failure(add(1))).hint).toBe("file:pending_max");
  });

  it("a merge points links at the kept record and releases the duplicate's unused file", async () => {
    const keep = await insertLead(owner.id, org, { full_name: "שומר" });
    const dup = await insertLead(owner.id, org, { full_name: "כפול" });
    const keepFile = await upload(owner.id, keep, "contract");
    const dupFile = await upload(owner.id, dup, "contract");
    const dupScan = await upload(owner.id, dup, "scan");
    await setField(owner.id, "leads", keep, { contract: keepFile.id });
    await setField(owner.id, "leads", dup, { contract: dupFile.id, scan: dupScan.id });
    const pointer = await insertLead(owner.id, org, { full_name: "מפנה", custom_fields: JSON.stringify({ referrer: dup }) });
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep, dup]));
    expect((await fieldsOf("leads", pointer)).referrer).toBe(keep);
    // follow-up: repointing writes no entry
    expect(await linkEntries("lead_id", pointer)).toEqual([]);
    const kept = await fieldsOf("leads", keep);
    expect(kept.contract).toBe(keepFile.id);
    expect(kept.scan).toBe(dupScan.id);
    // the scan moved with the duplicate's files and is the kept lead's value; the duplicate's contract went
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1 and lead_id = $2", [dupScan.id, keep]))).toBe(1);
    expect(await fileExists(dupFile.id)).toBe(0);
    expect(await fileExists(keepFile.id)).toBe(1);
  });

  it("a conversion copies a record link to a field of the same target, never a file", async () => {
    const target = await contact(rep.id, org, "מקושר");
    const lead = await insertLead(rep.id, org, { owner_id: rep.id, full_name: "ממיר", custom_fields: JSON.stringify({ client: target }) });
    const file = await upload(rep.id, lead, "contract");
    await setField(rep.id, "leads", lead, { contract: file.id });
    const made = await asUser(rep.id, async (q) => (await q<{ r: { contact_id: string } }>("select public.convert_lead($1) as r", [lead])).rows[0].r.contact_id);
    const fields = await fieldsOf("contacts", made);
    expect(fields.client).toBe(target);
    expect(fields.contract).toBeUndefined();
  });

  it("an automation neither sets nor clears a record link or a file", async () => {
    const target = await contact(owner.id, org, "לאוטומציה");
    const lead = await insertLead(owner.id, org, { custom_fields: JSON.stringify({ client: target }) });
    const run = async (actions: unknown[]) => {
      const rule = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
             values ($1, 'קישור', 'lead', 'created', '{}', '[]', $2, false) returning id`,
            [org, JSON.stringify(actions)],
          )
        ).rows[0].id,
      );
      await asUser(owner.id, (q) => q("select public.run_automation_now($1, $2)", [rule, lead]));
      return asAdmin(async (q) => (await q<{ steps: Array<{ status: string; error?: string }> }>("select steps from public.automation_runs where automation_id = $1", [rule])).rows[0].steps);
    };
    for (const value of [null, lead]) {
      const steps = await run([{ type: "set_field", field: "cf:client", value }]);
      expect(steps[0]).toMatchObject({ status: "error", error: "the value does not fit the field" });
    }
    expect((await fieldsOf("leads", lead)).client).toBe(target);
    // other fields still work
    const ok = await run([{ type: "set_field", field: "cf:site", value: "הנביאים 5" }]);
    expect(ok[0].status).toBe("ok");
  });

  it("review F1: removing sample data clears a real record's link to a sample record and is not refused", async () => {
    const sOwner = await createUser("fld06b-sample");
    const sOrg = await createOrg(sOwner.id, "עסק דוגמה");
    await define(sOrg, "lead", "ref_contact", "record_link", { target: "contact" });
    await asUser(sOwner.id, (q) => q("select public.sample_data_add($1)", [sOrg]));
    const sample = await asAdmin(async (q) => (await q<{ id: string }>("select contact_id as id from app.sample_records where organization_id = $1 and contact_id is not null limit 1", [sOrg])).rows[0].id);
    const real = await insertLead(sOwner.id, sOrg, { full_name: "אמיתי", custom_fields: JSON.stringify({ ref_contact: sample }) });
    const res = await asUser(sOwner.id, (q) => q<{ r: { removed: number; kept: number } }>("select public.sample_data_remove($1) as r", [sOrg]));
    expect(res.rows[0].r.removed).toBeGreaterThan(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1", [sample]))).toBe(0);
    expect((await fieldsOf("leads", real)).ref_contact).toBeUndefined();
  });

  it("review F1: the server's link setting does not let a person's automation write pass", async () => {
    const target = await contact(owner.id, org, "הגדרה");
    const lead = await insertLead(owner.id, org, {});
    // a person's own session cannot use the setting to write a link while automation_running is on
    const err = await failure(
      asUser(owner.id, async (q) => {
        await q("select set_config('app.automation_running', 'on', true), set_config('app.field_links_server', 'on', true)");
        await q("update public.leads set custom_fields = $2 where id = $1", [lead, JSON.stringify({ $merge: { client: target } })]);
      }),
    );
    expect(err.hint).toBe("custom_field:automation");
  });

  it("review F2: only the canonical lower-case id is a value", async () => {
    expect(await valueOk("record_link", "0B7C7C64-34C4-4B4E-9B62-0D9F8A3C1E11")).toBe(false);
    expect(await valueOk("file", "0B7C7C64-34C4-4B4E-9B62-0D9F8A3C1E11")).toBe(false);
    // a "user" field keeps taking either case, as before
    expect(await valueOk("user", "0B7C7C64-34C4-4B4E-9B62-0D9F8A3C1E11")).toBe(true);
    const target = await contact(owner.id, org, "אותיות");
    const lead = await insertLead(owner.id, org, {});
    expect((await failure(setField(owner.id, "leads", lead, { client: target.toUpperCase() }))).hint).toBe("custom_field:invalid");
  });

  it("review F3: a public form neither shows nor reads a record link or a file field", async () => {
    const target = await contact(owner.id, org, "טופס");
    const form = await asUser(owner.id, async (q) =>
      (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name) values ($1, 'שדות ב') returning id, token", [org])).rows[0],
    );
    await asAdmin((q) =>
      q("update public.forms set fields = $2 where id = $1", [form.id, JSON.stringify([{ key: "full_name" }, { key: "phone" }, { key: "cf:site" }, { key: "cf:client" }, { key: "cf:contract" }])]),
    );
    const shown = await asService(async (q) => (await q<{ r: { fields: Array<{ key: string }> } }>("select public.intake_form($1) as r", [form.token])).rows[0].r);
    expect(shown.fields.map((f) => f.key)).toEqual(["full_name", "phone", "cf:site"]);
    const reply = await asService(async (q) =>
      (
        await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'form', $2) as r", [
          form.token,
          JSON.stringify({ full_name: "מבקר", phone: "052-8199001", custom: { site: "הרצל 3", client: target, contract: target } }),
        ])
      ).rows[0].r,
    );
    expect(await fieldsOf("leads", reply.lead_id)).toEqual({ site: "הרצל 3" });
  });

  it("review F5: running 020905 again keeps the pasted release", async () => {
    // the stub is made only while the function is missing, so 020910's later body is the one that stays; later files that
    // redefine one of 020905's functions (the follow-up's app.record_links_clear_ids) run again after it. 020910 itself is
    // left out on purpose: the point is that 020905 alone does not undo it.
    const rerun = rerunClosure([PART_B]);
    const files = rerun.files.filter((file) => !file.endsWith("_field_file_release.sql"));
    expect(staleRestores(files).filter((line) => !line.startsWith("app.custom_field_file_drop:"))).toEqual([]);
    for (const file of files) await asAdmin((q) => q(readFileSync(join(MIGRATIONS_DIR, file), "utf8")));
    const body = await asAdmin(async (q) => (await q<{ d: string }>("select pg_get_functiondef('app.custom_field_file_drop(uuid, text, uuid, text, uuid)'::regprocedure) as d")).rows[0].d);
    expect(body).toContain("delete from public.files");
  });

  it("review F6: the key and record type of a record link or file field never change", async () => {
    const id = await define(org, "company", "owner_link", "record_link", { target: "contact" });
    const fileId = await define(org, "company", "doc", "file");
    for (const [field, sql] of [
      [id, "key = 'owner_link2'"],
      [id, "object_type = 'deal'"],
      [fileId, "key = 'doc2'"],
      [fileId, "object_type = 'lead'"],
    ]) {
      expect((await failure(asUser(owner.id, (q) => q(`update public.field_definitions set ${sql} where id = $1`, [field])))).hint, sql).toBe("custom_field:type_locked");
    }
  });
});

