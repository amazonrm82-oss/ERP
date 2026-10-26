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

  it("CNS-06 answer 3: the job keeps how many granted consents were locked, over all its calls; only the server writes it", async () => {
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'all', $2, 'complaint')", [org, ["listed-count@example.test", "050-7730001"]]));
    const optedOut = await insertLead(owner.id, org, { full_name: "הסיר את עצמו", email: "gone-count@example.test" });
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'withdrawn', 'manual', 'ביקש בטלפון')", [org, optedOut]),
    );
    const job = await newJob(manager, org, declared);
    const lockedOf = async () =>
      asUser(manager.id, async (q) => (await q<{ n: number }>("select consents_locked as n from public.import_jobs where id = $1", [job])).rows[0].n);
    expect(await lockedOf()).toBe(0);
    const a = await importedLead(manager, job, { full_name: "א", email: "listed-count@example.test", phone: "050-7730001" });
    const b = await importedLead(manager, job, { full_name: "ב", email: "gone-count@example.test", phone: "050-7730002" });
    expect(
      await record(manager, org, job, [
        { record_id: a, channel: "email", state: "granted", address: "listed-count@example.test" },
        { record_id: a, channel: "sms", state: "granted", address: "+972507730001" },
        // a 'denied' of a listed address is written, and is not counted
        { record_id: a, channel: "whatsapp", state: "denied", address: "+972507730001" },
      ]),
    ).toEqual(["locked", "locked", "written"]);
    expect(await lockedOf()).toBe(2);
    expect(
      await record(manager, org, job, [
        { record_id: b, channel: "email", state: "granted", address: "gone-count@example.test" },
        { record_id: b, channel: "sms", state: "granted", address: "+972507730002" },
      ]),
    ).toEqual(["locked", "written"]);
    // summed over the calls (each chunk of the wizard is one call)
    expect(await lockedOf()).toBe(3);
    // nothing was recorded for the locked ones
    expect((await consentsOf("lead", a)).map((r) => [r.channel, r.state])).toEqual([["whatsapp", "denied"]]);
    // server only: the importer cannot set it, and an owner cannot either
    for (const who of [manager, owner]) {
      const err = await asUser(who.id, (q) => q("update public.import_jobs set consents_locked = 0 where id = $1", [job])).catch((e) => e);
      expect((err as { code?: string }).code).toBe("42501");
    }
    expect(await lockedOf()).toBe(3);
  });

  it("a register refusal for a blocklisted address (an admin's import racing an addition to the list) is a locked answer", async () => {
    // the race made deterministic: the shared lock answers "open" for this one call (a function replaced inside the
    // transaction, which is rolled back), while the register's own check (consents_prepare) sees the listed address and
    // refuses an owner with the hint consent:blocklisted
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'email', $2, 'complaint')", [org, ["race-listed@example.test"]]));
    const job = await newJob(owner, org, declared);
    const lead = await importedLead(owner, job, { full_name: "מרוץ", email: "race-listed@example.test" });
    const ROLLBACK = new Error("rollback");
    let answered: { r: string[]; n: number } | null = null;
    await asUser(owner.id, async (q) => {
      await q("reset role");
      await q(
        `create or replace function app.consent_address_locked(p_org uuid, p_lead uuid, p_contact uuid, p_channel text, p_address text)
         returns boolean language sql stable as $$ select false $$`,
      );
      await q("set local role authenticated");
      const r = (
        await q<{ r: string[] }>("select public.import_record_consents($1, $2, $3) as r", [
          org,
          job,
          JSON.stringify([{ record_id: lead, channel: "email", state: "granted", address: "race-listed@example.test" }]),
        ])
      ).rows[0].r;
      const n = (await q<{ n: number }>("select consents_locked as n from public.import_jobs where id = $1", [job])).rows[0].n;
      answered = { r, n };
      throw ROLLBACK;
    }).catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
    expect(answered).toEqual({ r: ["locked"], n: 1 });
    expect(await consentsOf("lead", lead)).toEqual([]);
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

  it("undoing the import keeps its consent rows as history, adds one cancelling entry each; the records go to the recycle bin", async () => {
    const job = await newJob(owner, org, declared);
    const lead = await importedLead(owner, job, { full_name: "בוטל", email: "undo@example.test" });
    expect(await record(owner, org, job, [{ record_id: lead, channel: "email", state: "granted", address: "undo@example.test" }])).toEqual(["written"]);
    await finish(owner, job);
    expect(await asUser(owner.id, async (q) => (await q<{ r: Row }>("select public.undo_import($1, $2) as r", [org, job])).rows[0].r)).toEqual({
      done: 1,
      consents: 1,
    });
    const leadRow = await asAdmin(async (q) => (await q<{ deleted_at: string | null }>("select deleted_at from public.leads where id = $1", [lead])).rows[0]);
    expect(leadRow.deleted_at).not.toBeNull();
    expect((await consentsOf("lead", lead)).map((r) => [r.state, r.source, r.method, r.address_hash, r.hash_version, r.recorded_by])).toEqual([
      ["granted", "import", METHOD, hmac(`${org}:email:undo@example.test`), 1, owner.id],
      ["unknown", "import", "ביטול ייבוא", null, 0, owner.id],
    ]);
  });

  // --------------------------------------------------------------------------
  // CNS-05 undo (owner, 26 October 2026, answer 1 (ג)): the import's consents get a cancelling entry. Fail-safe until the
  // owner answers (review): only its 'granted' entries; its 'denied' entries stay in force
  // --------------------------------------------------------------------------
  const finish = (who: U, job: string) => asUser(who.id, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
  const undo = (who: U, job: string, o = org) =>
    asUser(who.id, async (q) => (await q<{ r: Row }>("select public.undo_import($1, $2) as r", [o, job])).rows[0].r);
  /** The organization-wide state of an address (the one rule senders use), as the server asks it. */
  const stateOf = (channel: string, address: string) =>
    asAdmin(
      async (q) =>
        (
          await q<{ s: string | null }>(
            "select app.consent_state_of($1, $2, app.consent_address_hash($1, app.consent_address_kind($2), $3, 1::smallint), null, null) as s",
            [org, channel, address],
          )
        ).rows[0].s,
    );
  const suppressed = (channel: string, address: string) =>
    asAdmin(async (q) => (await q<{ s: boolean | null }>("select app.consent_suppressed($1, $2, $3) as s", [org, channel, address])).rows[0].s);
  const card = (who: U, kind: "lead" | "contact", id: string) =>
    asUser(who.id, async (q) =>
      (await q<Row>(`select channel, state, source from public.consent_current($1, '${kind}', $2) order by channel`, [org, id])).rows,
    );
  const cancelRows = (job: string) =>
    asAdmin(
      async (q) =>
        (
          await q<Row>(
            `select k.channel, k.state, k.source, k.method, k.address_hash, k.hash_version, k.recorded_by, k.lead_id, k.contact_id,
                    k.subject_id, c.state as cancelled_state, c.id as cancelled_id
               from public.consents k join public.consents c on c.id = k.cancels
              where k.import_job_id = $1 and k.cancels is not null order by k.seq`,
            [job],
          )
        ).rows,
    );

  it("undo writes one cancelling entry per 'granted' of the job; its 'denied' entries stay in force, also on a record it did not create", async () => {
    // a lead that was there before: a skipped duplicate in the file still records its 'denied'
    const before = await insertLead(owner.id, org, { full_name: "היה קודם", phone: "050-7720001", owner_id: owner.id });
    const job = await newJob(owner, org, declared);
    const a = await importedLead(owner, job, { full_name: "א", email: "cancel-a@example.test" });
    const b = await importedLead(owner, job, { full_name: "ב", phone: "050-7720002" });
    expect(
      await record(owner, org, job, [
        { record_id: a, channel: "email", state: "granted", address: "cancel-a@example.test" },
        { record_id: b, channel: "sms", state: "denied", address: "050-7720002" },
        { record_id: b, channel: "whatsapp", state: "granted", address: "050-7720002" },
        { record_id: before, channel: "sms", state: "denied", address: "050-7720001" },
      ]),
    ).toEqual(["written", "written", "written", "written"]);
    const written = await asAdmin(
      async (q) => (await q<Row>("select id, state, import_job_id from public.consents where import_job_id = $1 order by seq", [job])).rows,
    );
    expect(written.map((r) => r.state)).toEqual(["granted", "denied", "granted", "denied"]);
    expect(await stateOf("sms", "+972507720001")).toBe("out");
    await finish(owner, job);
    expect(await undo(owner, job)).toEqual({ done: 2, consents: 2 });

    const rows = await cancelRows(job);
    expect(rows.map((r) => r.cancelled_id)).toEqual(written.filter((r) => r.state === "granted").map((r) => r.id));
    expect(rows.map((r) => [r.channel, r.cancelled_state])).toEqual([
      ["email", "granted"],
      ["whatsapp", "granted"],
    ]);
    for (const r of rows) {
      expect([r.state, r.source, r.method, r.address_hash, r.hash_version, r.recorded_by]).toEqual(["unknown", "import", "ביטול ייבוא", null, 0, owner.id]);
    }
    // each on the record of the entry it cancels
    expect(rows.map((r) => r.lead_id)).toEqual([a, b]);
    // nothing of the import's entries changed (append-only)
    expect(
      await asAdmin(async (q) => (await q<Row>("select id, state, import_job_id from public.consents where import_job_id = $1 and cancels is null order by seq", [job])).rows),
    ).toEqual(written);
    // the granted addresses are back where they were (nothing recorded); the opt-outs stand
    expect(await stateOf("email", "cancel-a@example.test")).toBeNull();
    expect(await stateOf("whatsapp", "+972507720002")).toBeNull();
    expect(await stateOf("sms", "+972507720002")).toBe("out");
    expect(await stateOf("sms", "+972507720001")).toBe("out");
    expect(await suppressed("sms", "050-7720001")).toBe(true);
    expect(await card(owner, "lead", before)).toEqual([{ channel: "sms", state: "denied", source: "import" }]);
    // the undo is audited with counts only
    const audit = await asAdmin(
      async (q) => (await q<Row>("select actor_id, entity_type, changes from public.audit_log where entity_id = $1 and action = 'import_consent_undo'", [job])).rows,
    );
    expect(audit).toEqual([{ actor_id: owner.id, entity_type: "import_jobs", changes: { granted: 2 } }]);
  });

  it("after undo an import's 'denied' stays in force over an earlier form consent (fail-safe); a cancelled 'granted' gives back the earlier state", async () => {
    // an earlier form consent for this email on another record (server write, like the public form)
    const formLead = await insertLead(owner.id, org, { full_name: "מהטופס", email: "had-form@example.test" });
    await asAdmin((q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'email', 'granted', 'form')", [org, formLead]),
    );
    // an earlier opt-out for this phone on another record
    const outLead = await insertLead(owner.id, org, { full_name: "הסיר", phone: "050-7720003" });
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'withdrawn', 'manual', 'ביקש')", [org, outLead]),
    );
    // a record with a manual consent that an update-mode import marks as denied
    const kept = await insertLead(owner.id, org, { full_name: "מעודכן", email: "updated@example.test", owner_id: owner.id });
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'granted', 'manual', 'בעל פה')", [org, kept]),
    );
    // a record with a manual opt-out on sms that the update-mode import later marks granted on email
    const regranted = await insertLead(owner.id, org, { full_name: "אושר שוב", email: "regranted@example.test", owner_id: owner.id });
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'granted', 'manual', 'בטלפון')", [org, regranted]),
    );
    expect(await stateOf("email", "had-form@example.test")).toBe("in");
    expect(await stateOf("sms", "+972507720003")).toBe("out");
    expect(await stateOf("email", "updated@example.test")).toBe("in");

    const job = await newJob(owner, org, { ...declared, duplicate_mode: "update" });
    const fresh = await importedLead(owner, job, { full_name: "חדש", email: "had-form@example.test", phone: "050-7720003" });
    expect(
      await record(owner, org, job, [
        { record_id: fresh, channel: "email", state: "denied", address: "had-form@example.test" },
        { record_id: fresh, channel: "sms", state: "granted", address: "050-7720003" },
        { record_id: fresh, channel: "sms", state: "denied", address: "050-7720003" },
        { record_id: kept, channel: "email", state: "denied", address: "updated@example.test" },
        { record_id: regranted, channel: "email", state: "granted", address: "regranted@example.test" },
      ]),
    ).toEqual(["written", "locked", "written", "written", "written"]);
    expect(await stateOf("email", "had-form@example.test")).toBe("out");
    expect(await stateOf("email", "updated@example.test")).toBe("out");
    expect(await card(owner, "lead", kept)).toEqual([{ channel: "email", state: "denied", source: "import" }]);
    expect(await card(owner, "lead", regranted)).toEqual([{ channel: "email", state: "granted", source: "import" }]);

    await finish(owner, job);
    expect(await undo(owner, job)).toEqual({ done: 1, consents: 1 });
    // the import's opt-outs stay in force: the earlier form consent does NOT count again, the update-mode 'denied' stands
    expect(await stateOf("email", "had-form@example.test")).toBe("out");
    expect(await suppressed("email", "had-form@example.test")).toBe(true);
    expect(await stateOf("email", "updated@example.test")).toBe("out");
    expect(await suppressed("email", "updated@example.test")).toBe(true);
    expect(await card(owner, "lead", kept)).toEqual([{ channel: "email", state: "denied", source: "import" }]);
    // the earlier opt-out still stands
    expect(await stateOf("sms", "+972507720003")).toBe("out");
    expect(await suppressed("sms", "050-7720003")).toBe(true);
    // the cancelled 'granted': the record's manual consent is its state again
    expect(await card(owner, "lead", regranted)).toEqual([{ channel: "email", state: "granted", source: "manual" }]);
    expect(await stateOf("email", "regranted@example.test")).toBe("in");
    // the opt-out still refuses a person's new 'granted' on the record (the register's lock is unchanged)
    expect(
      (
        await pgError(
          asUser(owner.id, (q) =>
            q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'x')", [org, outLead]),
          ),
        )
      ).hint,
    ).toBe("consent:optout_locked");
  });

  it("the blocklist and an erasure block are untouched by an undo", async () => {
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'email', $2, 'person_request')", [org, ["listed-undo@example.test"]]));
    const erasedLead = await insertLead(owner.id, org, { full_name: "ביקש מחיקה", phone: "050-7720004" });
    await asAdmin((q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'whatsapp', 'withdrawn', 'erasure')", [org, erasedLead]),
    );
    const job = await newJob(owner, org, declared);
    const lead = await importedLead(owner, job, { full_name: "חסום", email: "listed-undo@example.test", phone: "050-7720004" });
    expect(
      await record(owner, org, job, [
        { record_id: lead, channel: "email", state: "granted", address: "listed-undo@example.test" },
        { record_id: lead, channel: "email", state: "denied", address: "listed-undo@example.test" },
        { record_id: lead, channel: "whatsapp", state: "denied", address: "050-7720004" },
      ]),
    ).toEqual(["locked", "written", "written"]);
    await finish(owner, job);
    // its two opt-outs are not cancelled (fail-safe)
    expect(await undo(owner, job)).toEqual({ done: 1 });
    expect(await stateOf("email", "listed-undo@example.test")).toBe("listed");
    expect(await suppressed("email", "listed-undo@example.test")).toBe(true);
    expect(await stateOf("whatsapp", "+972507720004")).toBe("blocked");
    expect(await suppressed("whatsapp", "050-7720004")).toBe(true);
  });

  it("a converted imported lead: the copy on its contact is cancelled too", async () => {
    const job = await newJob(owner, org, declared);
    const lead = await importedLead(owner, job, { full_name: "הומר", email: "converted@example.test", owner_id: owner.id });
    expect(await record(owner, org, job, [{ record_id: lead, channel: "email", state: "granted", address: "converted@example.test" }])).toEqual(["written"]);
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ r: { contact_id: string } }>("select public.convert_lead($1) as r", [lead])).rows[0].r.contact_id,
    );
    expect(await card(owner, "contact", contact)).toEqual([{ channel: "email", state: "granted", source: "import" }]);
    await finish(owner, job);
    const result = await undo(owner, job);
    expect(result.consents).toBe(2);
    expect((await cancelRows(job)).map((r) => [r.lead_id, r.contact_id])).toEqual([
      [lead, null],
      [null, contact],
    ]);
    expect(await card(owner, "contact", contact)).toEqual([]);
    expect(await stateOf("email", "converted@example.test")).toBeNull();
  });

  it("undo_own_import cancels them too, and the import's own consents no longer keep a record out of the bin", async () => {
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, member.id, ["import"]]));
    try {
      const job = await newJob(member, org, declared);
      const lead = await importedLead(member, job, { full_name: "של נציג", email: "own-undo@example.test", owner_id: member.id });
      expect(await record(member, org, job, [{ record_id: lead, channel: "email", state: "granted", address: "own-undo@example.test" }])).toEqual([
        "written",
      ]);
      await finish(member, job);
      const result = await asUser(member.id, async (q) => (await q<{ r: Row }>("select public.undo_own_import($1, $2) as r", [org, job])).rows[0].r);
      expect(result).toEqual({ done: 1, kept: 0, consents: 1 });
      expect(await stateOf("email", "own-undo@example.test")).toBeNull();
      expect((await cancelRows(job)).map((r) => r.recorded_by)).toEqual([member.id]);
    } finally {
      await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, member.id, []]));
    }
  });

  it("only the server writes a cancelling entry, once, for the caller's own undone job of the business", async () => {
    const job = await newJob(owner, org, declared);
    const lead = await importedLead(owner, job, { full_name: "פעם אחת", email: "once@example.test" });
    expect(await record(owner, org, job, [{ record_id: lead, channel: "email", state: "granted", address: "once@example.test" }])).toEqual(["written"]);
    const entry = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.consents where import_job_id = $1", [job])).rows[0].id);
    // a person cannot write one (no column grant), not even on a manual entry of their own record
    for (const who of [owner, admin]) {
      const err = await pgError(
        asUser(who.id, (q) =>
          q("insert into public.consents (organization_id, lead_id, channel, state, source, method, cancels) values ($1, $2, 'email', 'denied', 'manual', 'x', $3)", [
            org,
            lead,
            entry,
          ]),
        ),
      );
      expect(err.code, who.email).toBe("42501");
      expect(
        (await pgError(asUser(who.id, (q) => q("select app.import_consents_cancel($1, $2)", [org, job])))).code,
        who.email,
      ).toBe("42501");
    }
    // the job is not undone yet: the cancel refuses even its creator
    expect((await pgError(asUser(owner.id, (q) => q("select app.import_consents_cancel($1, $2)", [org, job])))).code).toBe("42501");
    // a server write may cancel only an import's 'granted' (from a job, or its conversion copy) of the same channel
    const manual = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'granted', 'manual', 'x') returning id",
            [org, lead],
          )
        ).rows[0].id,
    );
    const serverCancel = (target: string, channel = "email") =>
      asAdmin((q) =>
        q("insert into public.consents (organization_id, lead_id, channel, state, source, import_job_id, cancels) values ($1, $2, $3, 'unknown', 'import', $4, $5)", [
          org,
          lead,
          channel,
          job,
          target,
        ]),
      );
    expect((await pgError(serverCancel(manual))).hint).toBe("consent:cancel");
    expect((await pgError(serverCancel(entry, "sms"))).hint).toBe("consent:cancel");
    // never an import 'granted' with neither a job nor a source entry (written before the job was kept)
    const legacy = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'granted', 'import', 'x') returning id",
            [org, lead],
          )
        ).rows[0].id,
    );
    expect((await pgError(serverCancel(legacy))).hint).toBe("consent:cancel");
    // nor an import's 'denied' (fail-safe: cancelling it could lift an opt-out)
    const denied = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.consents (organization_id, lead_id, channel, state, source, method, import_job_id) values ($1, $2, 'email', 'denied', 'import', 'x', $3) returning id",
            [org, lead, job],
          )
        ).rows[0].id,
    );
    expect((await pgError(serverCancel(denied))).hint).toBe("consent:cancel");
    // another person of the business and an outsider cannot undo the owner's job
    await finish(owner, job);
    expect((await pgError(undo(admin, job))).code).toBe("P0002");
    expect((await pgError(undo(outsider, job, otherOrg))).code).toBe("P0002");
    expect((await pgError(undo(outsider, job))).code).toBe("P0002");
    expect(await undo(owner, job)).toEqual({ done: 1, consents: 1 });
    // twice: the undo refuses, and the cancel itself writes nothing new
    expect((await pgError(undo(owner, job))).hint).toBe("import_undo:status");
    expect(await asUser(owner.id, async (q) => (await q<{ n: number }>("select app.import_consents_cancel($1, $2) as n", [org, job])).rows[0].n)).toBe(0);
    expect((await pgError(asUser(admin.id, (q) => q("select app.import_consents_cancel($1, $2)", [org, job])))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("select app.import_consents_cancel($1, $2)", [otherOrg, job])))).code).toBe("42501");
    expect((await cancelRows(job)).length).toBe(1);
    // a cancelling entry cannot be changed or pointed elsewhere
    expect((await pgError(asAdmin((q) => q("update public.consents set cancels = $1 where cancels = $2", [manual, entry])))).hint).toBe(
      "consent:append_only",
    );
    expect((await pgError(asAdmin((q) => q("update public.consents set import_job_id = null, cancels = null where cancels = $1", [entry])))).hint).toBe(
      "consent:append_only",
    );
    // a second cancelling entry for the same entry is refused by the unique index
    expect((await pgError(serverCancel(entry))).code).toBe("23505");
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
