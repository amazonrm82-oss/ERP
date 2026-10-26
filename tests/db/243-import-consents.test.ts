import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const setKey = (value: string | null) =>
  asAdmin((q) =>
    value === null
      ? q("update app.settings set value = '' where key = 'consent_hash_key'")
      : q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]),
  );
beforeAll(() => setKey(KEY));
afterAll(async () => {
  await setKey(KEY);
  await closePool();
});

type U = { id: string; email: string };
type Row = Record<string, unknown>;
type Item = { record_id: string; channel: string; state: string; address: string | null };
const hmac = (text: string) => createHmac("sha256", KEY).update(text, "utf8").digest("hex");

const METHOD = "טופס הרשמה באתר או בדף נחיתה: רשימת הנרשמים מהאתר 2025";

/**
 * CNS-05: a leads or contacts import may carry consent columns. The importer declares the consents' source when the job
 * is made (audited); public.import_record_consents writes them through the register (source 'import'), never lifts an
 * opt-out or an erasure block with a 'granted', and only for the caller's own running job.
 */
describe("consent columns in an import (CNS-05)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;

  const newJob = (who: U, o: string, fields: Row = {}) =>
    asUser(who.id, async (q) => {
      const row: Row = { organization_id: o, entity_type: "lead", file_name: "list.csv", duplicate_mode: "skip", total_rows: 3, ...fields };
      const cols = Object.keys(row);
      return (
        await q<{ id: string }>(
          `insert into public.import_jobs (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          Object.values(row),
        )
      ).rows[0].id;
    });
  const declared = { consent_method: "website_form", consent_note: "  רשימת הנרשמים מהאתר 2025 " };
  const record = (who: U, o: string, job: string, items: Item[]) =>
    asUser(who.id, async (q) => (await q<{ r: string[] }>("select public.import_record_consents($1, $2, $3) as r", [o, job, JSON.stringify(items)])).rows[0].r);
  const consentsOf = (kind: "lead" | "contact", id: string) =>
    asAdmin(
      async (q) =>
        (
          await q<Row>(
            `select channel, state, source, method, wording, wording_version, address_hash, hash_version, recorded_by
               from public.consents where ${kind}_id = $1 order by seq`,
            [id],
          )
        ).rows,
    );
  const importedLead = (who: U, job: string, fields: Row) => insertLead(who.id, org, { import_job_id: job, ...fields });

  beforeAll(async () => {
    owner = await createUser("ic-owner");
    org = await createOrg(owner.id, "עסק ייבוא הסכמות");
    admin = await addMember(org, owner.id, "admin", "ic-admin");
    manager = await addMember(org, owner.id, "manager", "ic-manager");
    member = await addMember(org, owner.id, "member", "ic-member");
    viewer = await addMember(org, owner.id, "viewer", "ic-viewer");
    outsider = await createUser("ic-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  it("the declaration is a closed choice with a required note, on leads or contacts only, and it is audited", async () => {
    expect((await pgError(newJob(owner, org, { consent_method: "website_form" }))).hint).toBe("import_consent:note");
    expect((await pgError(newJob(owner, org, { consent_method: "website_form", consent_note: "   " }))).hint).toBe("import_consent:note");
    expect((await pgError(newJob(owner, org, { consent_note: "בלי מקור" }))).hint).toBe("import_consent:note");
    expect((await pgError(newJob(owner, org, { consent_method: "rumour", consent_note: "x" }))).code).toBe("23514");
    expect((await pgError(newJob(owner, org, { entity_type: "company", ...declared }))).hint).toBe("import_consent:entity");
    expect((await pgError(newJob(owner, org, { consent_method: "other", consent_note: "x".repeat(501) }))).code).toBe("23514");

    const job = await newJob(owner, org, { entity_type: "contact", ...declared });
    const stored = await asAdmin(async (q) => (await q<Row>("select consent_method, consent_note from public.import_jobs where id = $1", [job])).rows[0]);
    expect(stored).toEqual({ consent_method: "website_form", consent_note: "רשימת הנרשמים מהאתר 2025" });
    const audit = await asAdmin(
      async (q) => (await q<Row>("select actor_id, action, entity_type, changes from public.audit_log where entity_id = $1", [job])).rows,
    );
    expect(audit).toEqual([
      {
        actor_id: owner.id,
        action: "import_consent",
        entity_type: "import_jobs",
        changes: { consent_method: "website_form", consent_note: "רשימת הנרשמים מהאתר 2025", entity_type: "contact", file_name: "list.csv" },
      },
    ]);
    // never changed afterwards: no update grant
    expect((await pgError(asUser(owner.id, (q) => q("update public.import_jobs set consent_note = 'אחר' where id = $1", [job])))).code).toBe("42501");
    // a job without consent columns writes no audit entry
    const plain = await newJob(owner, org);
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1", [plain]))).toBe(0);
  });

  it("granted and denied are written through the register with source import, the declaration and the hash", async () => {
    const job = await newJob(owner, org, declared);
    const lead = await importedLead(owner, job, { full_name: "דנה", phone: "050-7710001", email: "Dana.Import@Example.Test" });
    const result = await record(owner, org, job, [
      { record_id: lead, channel: "email", state: "granted", address: "dana.import@example.test" },
      { record_id: lead, channel: "sms", state: "denied", address: "+972507710001" },
      { record_id: lead, channel: "whatsapp", state: "granted", address: "050-7710001" },
      { record_id: lead, channel: "phone", state: "granted", address: "+972507710001" },
      { record_id: lead, channel: "email", state: "withdrawn", address: "dana.import@example.test" },
      { record_id: "not-a-uuid", channel: "email", state: "granted", address: "x@y.z" },
    ]);
    expect(result).toEqual(["written", "written", "written", "invalid", "invalid", "invalid"]);
    expect(await consentsOf("lead", lead)).toEqual([
      {
        channel: "email",
        state: "granted",
        source: "import",
        method: METHOD,
        wording: null,
        wording_version: null,
        address_hash: hmac(`${org}:email:dana.import@example.test`),
        hash_version: 1,
        recorded_by: owner.id,
      },
      {
        channel: "sms",
        state: "denied",
        source: "import",
        method: METHOD,
        wording: null,
        wording_version: null,
        address_hash: hmac(`${org}:phone:+972507710001`),
        hash_version: 1,
        recorded_by: owner.id,
      },
      {
        channel: "whatsapp",
        state: "granted",
        source: "import",
        method: METHOD,
        wording: null,
        wording_version: null,
        address_hash: hmac(`${org}:phone:+972507710001`),
        hash_version: 1,
        recorded_by: owner.id,
      },
    ]);
    // the record's current state reads the import entries like any other
    const current = await asUser(owner.id, async (q) =>
      (await q<Row>("select channel, state, source from public.consent_current($1, 'lead', $2) order by channel", [org, lead])).rows,
    );
    expect(current).toEqual([
      { channel: "email", state: "granted", source: "import" },
      { channel: "sms", state: "denied", source: "import" },
      { channel: "whatsapp", state: "granted", source: "import" },
    ]);
  });

  it("only on the record's own primary address; a file address that is not the record's writes nothing", async () => {
    const job = await newJob(owner, org, declared);
    const lead = await importedLead(owner, job, { full_name: "רון", phone: "050-7710002" });
    expect(
      await record(owner, org, job, [
        { record_id: lead, channel: "email", state: "granted", address: "ron@example.test" },
        { record_id: lead, channel: "sms", state: "granted", address: "+972507719999" },
        { record_id: lead, channel: "sms", state: "denied", address: null },
      ]),
    ).toEqual(["other_address", "other_address", "other_address"]);
    expect(await consentsOf("lead", lead)).toEqual([]);
  });

  it("a granted never lifts an opt-out or an erasure block of the address; a denied is always written", async () => {
    // someone with this email opted out on another record of the business
    const old = await insertLead(owner.id, org, { full_name: "ישן", email: "optout@example.test", phone: "050-7710003" });
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'withdrawn', 'manual', 'ביקש בטלפון')", [org, old]),
    );
    // and another one asked to be erased (server mark)
    const erased = await insertLead(owner.id, org, { full_name: "נמחק", phone: "050-7710004" });
    await asAdmin((q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'whatsapp', 'withdrawn', 'erasure')", [org, erased]),
    );

    const job = await newJob(manager, org, declared);
    const lead = await importedLead(manager, job, { full_name: "חדש", email: "OptOut@Example.Test", phone: "050-7710004" });
    expect(
      await record(manager, org, job, [
        { record_id: lead, channel: "email", state: "granted", address: "optout@example.test" },
        { record_id: lead, channel: "whatsapp", state: "granted", address: "+972507710004" },
        { record_id: lead, channel: "sms", state: "granted", address: "+972507710004" },
        { record_id: lead, channel: "email", state: "denied", address: "optout@example.test" },
      ]),
    ).toEqual(["locked", "locked", "written", "written"]);
    expect((await consentsOf("lead", lead)).map((r) => [r.channel, r.state])).toEqual([
      ["sms", "granted"],
      ["email", "denied"],
    ]);
    // the address is still suppressed for marketing
    const suppressed = await asAdmin(async (q) =>
      (await q<{ s: boolean }>("select app.consent_suppressed($1, 'whatsapp', '050-7710004') as s", [org])).rows[0].s,
    );
    expect(suppressed).toBe(true);
  });

  it("only the caller's own running leads or contacts job in the business, with a declaration, by someone who may import", async () => {
    const job = await newJob(owner, org, declared);
    const lead = await importedLead(owner, job, { full_name: "שירה", email: "shira@example.test" });
    const item: Item = { record_id: lead, channel: "email", state: "granted", address: "shira@example.test" };
    // another person of the business, even an admin, cannot use the owner's job
    for (const who of [admin, manager, member, viewer, outsider]) {
      expect((await pgError(record(who, org, job, [item]))).code, who.email).toBe("42501");
    }
    // the outsider names the job under their own business
    expect((await pgError(record(outsider, otherOrg, job, [item]))).code).toBe("42501");
    // a job without a declaration
    const plain = await newJob(owner, org);
    expect((await pgError(record(owner, org, plain, [item]))).hint).toBe("import_consent:undeclared");
    // too many in one call
    expect((await pgError(record(owner, org, job, Array.from({ length: 1001 }, () => item)))).hint).toBe("import_consent:too_many");
    // a finished job takes nothing more
    await asUser(owner.id, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
    expect((await pgError(record(owner, org, job, [item]))).code).toBe("42501");
    expect(await consentsOf("lead", lead)).toEqual([]);
  });

  it("a record the job did not create is refused, unless an update-mode job and the caller may edit it", async () => {
    const existing = await insertLead(owner.id, org, { full_name: "קיים", email: "exists@example.test", owner_id: owner.id });
    const item: Item = { record_id: existing, channel: "email", state: "granted", address: "exists@example.test" };
    const skipJob = await newJob(manager, org, declared);
    expect(await record(manager, org, skipJob, [item])).toEqual(["refused"]);
    const updateJob = await newJob(owner, org, { ...declared, duplicate_mode: "update" });
    expect(await record(owner, org, updateJob, [item])).toEqual(["written"]);
    // another business's record is never reached, whatever the mode
    const foreignJob = await asUser(outsider.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows, consent_method, consent_note) values ($1, 'lead', 'x.csv', 'update', 1, 'other', 'רשימה') returning id",
          [otherOrg],
        )
      ).rows[0].id,
    );
    expect(await record(outsider, otherOrg, foreignJob, [item])).toEqual(["refused"]);
    // a lead in the recycle bin is refused too
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [existing]));
    expect(await record(owner, org, updateJob, [item])).toEqual(["refused"]);
    expect((await consentsOf("lead", existing)).length).toBe(1);
  });

  it("a skipped duplicate records a 'denied' on the matched record the caller may edit; never a 'granted' (review of 8274c04)", async () => {
    const existing = await insertLead(owner.id, org, { full_name: "כפול", email: "dup@example.test", phone: "050-7710007", owner_id: owner.id });
    const skipJob = await newJob(owner, org, declared);
    expect(
      await record(owner, org, skipJob, [
        { record_id: existing, channel: "sms", state: "denied", address: "+972507710007" },
        { record_id: existing, channel: "email", state: "granted", address: "dup@example.test" },
      ]),
    ).toEqual(["written", "refused"]);
    expect((await consentsOf("lead", existing)).map((r) => [r.channel, r.state, r.source])).toEqual([["sms", "denied", "import"]]);
    // the primary-address rule still holds
    expect(await record(owner, org, skipJob, [{ record_id: existing, channel: "email", state: "denied", address: "other@example.test" }])).toEqual([
      "other_address",
    ]);
  });

  it("a manager's job never reaches a lead the manager may not edit, in any mode (review of 8274c04)", async () => {
    // a member's own lead, in no team the manager manages
    const theirs = await insertLead(member.id, org, { full_name: "של נציג אחר", email: "rep@example.test", owner_id: member.id });
    const editable = await asUser(manager.id, async (q) =>
      (await q<{ ok: boolean }>("select app.can_edit_record($1, $2, null) as ok", [org, member.id])).rows[0].ok,
    );
    expect(editable).toBe(false);
    for (const mode of ["update", "skip"]) {
      const job = await newJob(manager, org, { ...declared, duplicate_mode: mode });
      expect(
        await record(manager, org, job, [
          { record_id: theirs, channel: "email", state: "granted", address: "rep@example.test" },
          { record_id: theirs, channel: "email", state: "denied", address: "rep@example.test" },
        ]),
        mode,
      ).toEqual(["refused", "refused"]);
    }
    expect(await consentsOf("lead", theirs)).toEqual([]);
  });

  it("contacts take consents the same way", async () => {
    const job = await newJob(owner, org, { ...declared, entity_type: "contact" });
    const contact = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.contacts (organization_id, first_name, email, import_job_id) values ($1, 'נועה', 'noa@example.test', $2) returning id",
          [org, job],
        )
      ).rows[0].id,
    );
    const lead = await importedLead(owner, (await newJob(owner, org, declared)), { full_name: "x", email: "noa@example.test" });
    expect(
      await record(owner, org, job, [
        { record_id: contact, channel: "email", state: "granted", address: "noa@example.test" },
        // a lead id under a contacts job
        { record_id: lead, channel: "email", state: "granted", address: "noa@example.test" },
      ]),
    ).toEqual(["written", "refused"]);
    expect((await consentsOf("contact", contact)).map((r) => [r.channel, r.state, r.source])).toEqual([["email", "granted", "import"]]);
  });

  it("without the hash key: written with the pending address; any hashed opt-out on the channel blocks a granted", async () => {
    const job = await newJob(owner, org, declared);
    const lead = await importedLead(owner, job, { full_name: "בלי מפתח", email: "nokey@example.test", phone: "050-7710005" });
    await setKey(null);
    try {
      // the email channel has a hashed opt-out somewhere in the business: fail closed
      expect(
        await record(owner, org, job, [
          { record_id: lead, channel: "email", state: "granted", address: "nokey@example.test" },
          { record_id: lead, channel: "sms", state: "denied", address: "+972507710005" },
        ]),
      ).toEqual(["locked", "written"]);
    } finally {
      await setKey(KEY);
    }
    const rows = await asAdmin(
      async (q) =>
        (
          await q<Row>(
            `select c.channel, c.address_hash, p.value from public.consents c
               left join app.consent_pending_address p on p.consent_id = c.id where c.lead_id = $1`,
            [lead],
          )
        ).rows,
    );
    expect(rows).toEqual([{ channel: "sms", address_hash: null, value: "+972507710005" }]);
    // the backfill hashes it once the key is back
    await asAdmin((q) => q("select app.consent_backfill_hashes()"));
    expect((await consentsOf("lead", lead))[0].address_hash).toBe(hmac(`${org}:phone:+972507710005`));
  });

  it("undoing the import keeps the consent rows as history; the records go to the recycle bin", async () => {
    const job = await newJob(owner, org, declared);
    const lead = await importedLead(owner, job, { full_name: "בוטל", email: "undo@example.test" });
    expect(await record(owner, org, job, [{ record_id: lead, channel: "email", state: "denied", address: "undo@example.test" }])).toEqual(["written"]);
    await asUser(owner.id, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
    await asUser(owner.id, (q) => q("select public.undo_import($1, $2)", [org, job]));
    const leadRow = await asAdmin(async (q) => (await q<{ deleted_at: string | null }>("select deleted_at from public.leads where id = $1", [lead])).rows[0]);
    expect(leadRow.deleted_at).not.toBeNull();
    expect((await consentsOf("lead", lead)).map((r) => [r.state, r.source])).toEqual([["denied", "import"]]);
  });

  it("no client writes source import directly", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ישיר", email: "direct@example.test" });
    const err = await pgError(
      asUser(owner.id, (q) =>
        q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'granted', 'import', 'x')", [org, lead]),
      ),
    );
    expect(err.code).toBe("42501");
  });
});
