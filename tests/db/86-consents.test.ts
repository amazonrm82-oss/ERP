import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const setKey = (value: string | null) =>
  asAdmin((q) =>
    value === null
      ? q("update app.settings set value = '' where key = 'consent_hash_key'")
      : q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]),
  );
beforeAll(() => setKey(KEY));
afterAll(closePool);

type U = { id: string; email: string };
const sha = (text: string) => createHmac("sha256", KEY).update(text, "utf8").digest("hex");

// CNS-01..03: marketing consent per lead and contact, per channel, append-only.
describe("consents (CNS-01, CNS-02, CNS-03)", () => {
  let owner: U, member: U, other: U, viewer: U;
  let org: string;

  const record = (u: U, subject: { lead?: string; contact?: string }, fields: Record<string, unknown> = {}) =>
    asUser(u.id, async (q) => {
      const row: Record<string, unknown> = {
        organization_id: org,
        lead_id: subject.lead ?? null,
        contact_id: subject.contact ?? null,
        channel: "sms",
        state: "granted",
        source: "manual",
        method: "בשיחה טלפונית",
        ...fields,
      };
      const cols = Object.keys(row);
      return (
        await q<{ id: string; recorded_by: string | null; subject_type: string; subject_id: string }>(
          `insert into public.consents (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})
           returning id, recorded_by, subject_type, subject_id`,
          Object.values(row),
        )
      ).rows[0];
    });
  const current = (u: U, kind: string, id: string) =>
    asUser(u.id, async (q) =>
      (
        await q<{ channel: string; state: string; source: string; current_address: boolean }>(
          "select channel, state, source, current_address from public.consent_current($1, $2, $3) order by channel",
          [org, kind, id],
        )
      ).rows,
    );
  // clients may not read the hash; the tests read it as the server
  const hashOf = (id: string) =>
    asAdmin(async (q) => (await q<{ address_hash: string | null }>("select address_hash from public.consents where id = $1", [id])).rows[0].address_hash);

  beforeAll(async () => {
    owner = await createUser("cns-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "cns-member");
    other = await addMember(org, owner.id, "member", "cns-other");
    viewer = await addMember(org, owner.id, "viewer", "cns-viewer");
  });

  it("records who, when, how and a salted hash of the address; the server sets those, not the client", async () => {
    const lead = await insertLead(member.id, org, { phone: "050-1112233", email: " Dana@Example.Test " });
    const row = await record(member, { lead }, { method: "  טופס נייר בכנס  ", wording: "אני מסכים לקבל עדכונים" });
    expect(row.recorded_by).toBe(member.id);
    expect(row.subject_type).toBe("lead");
    expect(row.subject_id).toBe(lead);
    expect(await hashOf(row.id)).toBe(sha(`${org}:phone:+972501112233`));
    const email = await record(member, { lead }, { channel: "email" });
    expect(await hashOf(email.id)).toBe(sha(`${org}:email:dana@example.test`));
    // nobody reads the hash through the API, not even the owner
    for (const u of [owner, member]) {
      expect((await pgError(asUser(u.id, (q) => q("select address_hash from public.consents where id = $1", [row.id])))).code).toBe("42501");
      expect((await pgError(asUser(u.id, (q) => q("select * from public.consents where id = $1", [row.id])))).code).toBe("42501");
    }
    expect(await asUser(member.id, (q) => count(q, "select id, state, created_at from public.consents where id = $1", [row.id]))).toBe(1);
    const stored = await asAdmin(async (q) =>
      (await q<{ method: string; created_at: Date }>("select method, created_at from public.consents where id = $1", [row.id])).rows[0],
    );
    expect(stored.method).toBe("טופס נייר בכנס");
    expect(Math.abs(stored.created_at.getTime() - Date.now())).toBeLessThan(60_000);

    // a client cannot send recorded_by, created_at, the hash or the subject columns
    for (const [col, value] of [
      ["recorded_by", other.id],
      ["created_at", "2001-01-01"],
      ["address_hash", "x"],
      ["copied_from", row.id],
      ["hash_version", 1],
      ["subject_id", lead],
    ] as const) {
      const err = await pgError(record(member, { lead }, { [col]: value }));
      expect(err.code, col).toBe("42501");
    }
  });

  it("a manual entry needs how it was given and an address for the channel; only 'manual' from the browser", async () => {
    const lead = await insertLead(member.id, org, { phone: "050-1112234" });
    expect((await pgError(record(member, { lead }, { method: "   " }))).hint).toBe("consent:method");
    expect((await pgError(record(member, { lead }, { method: null }))).hint).toBe("consent:method");
    // no email on the lead
    expect((await pgError(record(member, { lead }, { channel: "email" }))).hint).toBe("consent:no_address");
    for (const source of ["form", "import", "api", "unsubscribe"]) {
      expect((await pgError(record(member, { lead }, { source }))).code, source).toBe("42501");
    }
    // exactly one record
    expect((await pgError(record(member, {}))).hint).toBe("consent:subject");
    const contact = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone) values ($1, 'רון', '050-1112299') returning id", [org])).rows[0].id,
    );
    expect((await pgError(record(member, { lead, contact }))).hint).toBe("consent:subject");
    // "unknown" is never recorded by hand
    expect((await pgError(record(member, { lead }, { state: "unknown" }))).code).toBe("23514");
    // closed lists
    expect((await pgError(record(member, { lead }, { channel: "fax" }))).code).toBe("23514");
    expect((await pgError(record(member, { lead }, { state: "maybe" }))).code).toBe("23514");
  });

  it("server writers may use the other sources and need no method", async () => {
    const lead = await insertLead(member.id, org, { phone: "050-1112235" });
    await asService(async (q) => {
      const row = (
        await q<{ recorded_by: string | null; address_hash: string | null }>(
          "insert into public.consents (organization_id, lead_id, channel, state, source, wording) values ($1, $2, 'whatsapp', 'granted', 'form', 'נוסח הטופס') returning recorded_by, address_hash",
          [org, lead],
        )
      ).rows[0];
      expect(row.recorded_by).toBeNull();
      expect(row.address_hash).toBe(sha(`${org}:phone:+972501112235`));
    });
  });

  it("the current state is the latest row per channel, and says when the address changed since", async () => {
    const lead = await insertLead(member.id, org, { phone: "050-1112236", email: "a@example.test" });
    await record(member, { lead }, { channel: "sms", state: "granted" });
    await record(member, { lead }, { channel: "sms", state: "withdrawn" });
    await record(member, { lead }, { channel: "email", state: "denied" });
    expect(await current(member, "lead", lead)).toEqual([
      { channel: "email", state: "denied", source: "manual", current_address: true },
      { channel: "sms", state: "withdrawn", source: "manual", current_address: true },
    ]);
    await asUser(member.id, (q) => q("update public.leads set phone = '050-9999999' where id = $1", [lead]));
    const after = await current(member, "lead", lead);
    expect(after.find((r) => r.channel === "sms")?.current_address).toBe(false);
    expect(after.find((r) => r.channel === "email")?.current_address).toBe(true);
    // the whole history stays
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.consents where lead_id = $1", [lead]))).toBe(3);
  });

  it("no edits and no deletes, for anyone, from the browser (CNS-02)", async () => {
    const lead = await insertLead(member.id, org, { phone: "050-1112237" });
    const row = await record(member, { lead });
    for (const u of [owner, member]) {
      expect((await pgError(asUser(u.id, (q) => q("update public.consents set state = 'denied' where id = $1", [row.id])))).code).toBe("42501");
      expect((await pgError(asUser(u.id, (q) => q("delete from public.consents where id = $1", [row.id])))).code).toBe("42501");
    }
  });

  it("server code cannot rewrite a fact either; texts may only be emptied", async () => {
    const lead = await insertLead(member.id, org, { phone: "050-1112238" });
    const row = await record(member, { lead }, { wording: "נוסח" });
    for (const set of [
      "state = 'denied'",
      "channel = 'email'",
      "source = 'form'",
      "created_at = '2001-01-01'",
      "address_hash = 'x'",
      "method = 'אחרת'",
      "wording = 'אחר'",
      `recorded_by = '${other.id}'`,
      "subject_type = 'contact'",
    ]) {
      expect((await pgError(asAdmin((q) => q(`update public.consents set ${set} where id = $1`, [row.id])))).hint, set).toBe("consent:append_only");
    }
    await asAdmin((q) => q("update public.consents set method = null, wording = null, recorded_by = null where id = $1", [row.id]));
  });

  it("the history outlives a purge: only the hash, state and time stay findable by the record id", async () => {
    const lead = await insertLead(member.id, org, { phone: "050-1112239" });
    const row = await record(member, { lead });
    await asAdmin((q) => q("delete from public.leads where id = $1", [lead]));
    const kept = await asAdmin(async (q) =>
      (
        await q<{ lead_id: string | null; subject_type: string; subject_id: string; address_hash: string; state: string }>(
          "select lead_id, subject_type, subject_id, address_hash, state from public.consents where id = $1",
          [row.id],
        )
      ).rows[0],
    );
    expect(kept).toEqual({ lead_id: null, subject_type: "lead", subject_id: lead, address_hash: sha(`${org}:phone:+972501112239`), state: "granted" });
    // nobody sees an orphaned row through the API
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.consents where id = $1", [row.id]))).toBe(0);
  });

  it("rights follow the record: read with the record, write when it may be edited", async () => {
    const mine = await insertLead(member.id, org, { phone: "050-1112240" });
    await record(member, { lead: mine });
    // another member reads (visibility org) but may not edit someone else's lead
    expect(await asUser(other.id, (q) => count(q, "select 1 from public.consents where lead_id = $1", [mine]))).toBe(1);
    expect((await pgError(record(other, { lead: mine }))).code).toBe("42501");
    expect((await pgError(record(viewer, { lead: mine }))).code).toBe("42501");
    expect(await asUser(viewer.id, (q) => count(q, "select 1 from public.consents where lead_id = $1", [mine]))).toBe(1);
    await record(owner, { lead: mine });

    // visibility own: the other member no longer sees the lead, nor its consents
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    expect(await asUser(other.id, (q) => count(q, "select 1 from public.consents where lead_id = $1", [mine]))).toBe(0);
    expect(await current(other, "lead", mine)).toEqual([]);
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));

    // a record in the recycle bin takes no new entry
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [mine]));
    expect((await pgError(record(member, { lead: mine }))).code).toBe("42501");
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = null where id = $1", [mine]));

    // a contact, like a lead
    const contact = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email) values ($1, 'מיכל', 'm@example.test') returning id", [org])).rows[0].id,
    );
    const row = await record(member, { contact }, { channel: "email" });
    expect(row.subject_type).toBe("contact");
    expect((await pgError(record(other, { contact }, { channel: "email" }))).code).toBe("42501");
    expect((await current(member, "contact", contact)).map((r) => r.state)).toEqual(["granted"]);

    // a read-only organization takes no new entry; reading goes on
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    expect((await pgError(record(member, { lead: mine }))).code).toBe("42501");
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.consents where lead_id = $1", [mine]))).toBe(2);
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
  });

  it("another organization neither reads nor writes them, and a hash differs between organizations", async () => {
    const stranger = await createUser("cns-stranger");
    const org2 = await createOrg(stranger.id);
    const lead = await insertLead(member.id, org, { phone: "050-1112241" });
    await record(member, { lead });
    expect(await asUser(stranger.id, (q) => count(q, "select 1 from public.consents where organization_id = $1", [org]))).toBe(0);
    expect(await asUser(stranger.id, (q) => count(q, "select 1 from public.consent_current($1, 'lead', $2)", [org, lead]))).toBe(0);
    // pointing a row of its own organization at org A's lead fails on the composite key or the policy
    const err = await pgError(
      asUser(stranger.id, (q) =>
        q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'x')", [org2, lead]),
      ),
    );
    expect(["42501", "23503"]).toContain(err.code);
    const lead2 = await insertLead(stranger.id, org2, { phone: "050-1112241" });
    const theirs = await asUser(stranger.id, async (q) =>
      (
        await q<{ id: string; address_hash?: string }>(
          "insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'x') returning id",
          [org2, lead2],
        )
      ).rows[0],
    );
    theirs.address_hash = (await hashOf(theirs.id)) ?? "";
    expect(theirs.address_hash).toBe(sha(`${org2}:phone:+972501112241`));
    expect(theirs.address_hash).not.toBe(sha(`${org}:phone:+972501112241`));
  });
});

// Follow-ups: merge, privacy erasure, conversion (LEAD-07), sample data, export columns.
describe("consents with merge, erasure, conversion and sample data", () => {
  let owner: U;
  let org: string;
  const add = (subject: { lead?: string; contact?: string }, channel: string, state: string, method = "בשיחה") =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method) values ($1, $2, $3, $4, $5, 'manual', $6) returning id",
          [org, subject.lead ?? null, subject.contact ?? null, channel, state, method],
        )
      ).rows[0].id,
    );
  const current = (kind: string, id: string) =>
    asUser(owner.id, async (q) =>
      (await q<{ channel: string; state: string }>("select channel, state from public.consent_current($1, $2, $3) order by channel", [org, kind, id])).rows,
    );
  const newContact = (fields: string, values: unknown[]) =>
    asUser(owner.id, async (q) => (await q<{ id: string }>(`insert into public.contacts (organization_id, ${fields}) values ($1, ${values.map((_, i) => `$${i + 2}`).join(", ")}) returning id`, [org, ...values])).rows[0].id);

  beforeAll(async () => {
    owner = await createUser("cns2-owner");
    org = await createOrg(owner.id);
  });

  it("a merge moves the duplicate's history to the kept record; the latest by time wins", async () => {
    const keep = await insertLead(owner.id, org, { full_name: "נועה", phone: "050-2220001" });
    const dup = await insertLead(owner.id, org, { full_name: "נועה כפולה", phone: "050-2220001" });
    await add({ lead: keep }, "sms", "granted");
    const withdrawn = await add({ lead: dup }, "sms", "withdrawn");
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep, dup]));
    const moved = await asAdmin(async (q) =>
      (await q<{ lead_id: string; subject_id: string }>("select lead_id, subject_id from public.consents where id = $1", [withdrawn])).rows[0],
    );
    expect(moved).toEqual({ lead_id: keep, subject_id: keep });
    expect(await current("lead", keep)).toEqual([{ channel: "sms", state: "withdrawn" }]);

    // contacts too
    const keepC = await newContact("first_name, email", ["רז", "raz@example.test"]);
    const dupC = await newContact("first_name, email", ["רז כפול", "raz@example.test"]);
    await add({ contact: dupC }, "email", "granted");
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keepC, dupC]));
    expect(await current("contact", keepC)).toEqual([{ channel: "email", state: "granted" }]);
  });

  it("the privacy erasure keeps only hash, state, channel, source and time", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "מחיקה", phone: "050-2220002" });
    const id = await add({ lead }, "sms", "granted", "אמר לי בטלפון 050-2220002");
    await asAdmin((q) => q("delete from public.leads where id = $1", [lead]));
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'leads', $2)", [org, lead]));
    const row = await asAdmin(async (q) =>
      (
        await q("select method, wording, recorded_by, state, channel, source, address_hash is not null as hashed, created_at is not null as timed from public.consents where id = $1", [id])
      ).rows[0],
    );
    expect(row).toEqual({ method: null, wording: null, recorded_by: null, state: "granted", channel: "sms", source: "manual", hashed: true, timed: true });

    // a contact likewise
    const contact = await newContact("first_name, email", ["מחיקה", "erase@example.test"]);
    const cid = await add({ contact }, "email", "denied", "בכנס");
    await asAdmin((q) => q("delete from public.contacts where id = $1", [contact]));
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    expect(await asAdmin(async (q) => (await q("select method from public.consents where id = $1", [cid])).rows[0].method)).toBeNull();
  });

  it("converting a lead copies its current consent of each channel to the new contact (LEAD-07)", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "המרה", phone: "050-2220003", email: "conv@example.test" });
    await add({ lead }, "sms", "granted");
    const latestSms = await add({ lead }, "sms", "withdrawn", "ביקש להסיר");
    const email = await add({ lead }, "email", "granted", "טופס נייר");
    const contactId = await asUser(owner.id, async (q) =>
      (await q<{ r: { contact_id: string } }>("select public.convert_lead($1, false) as r", [lead])).rows[0].r.contact_id,
    );
    const copies = await asAdmin(async (q) =>
      (
        await q<{ channel: string; state: string; source: string; method: string; copied_from: string; recorded_by: string; same_hash: boolean; same_time: boolean }>(
          `select c.channel, c.state, c.source, c.method, c.copied_from, c.recorded_by,
                  c.address_hash = o.address_hash as same_hash, c.created_at = o.created_at as same_time
             from public.consents c join public.consents o on o.id = c.copied_from
            where c.contact_id = $1 order by c.channel`,
          [contactId],
        )
      ).rows,
    );
    expect(copies).toEqual([
      { channel: "email", state: "granted", source: "manual", method: "טופס נייר", copied_from: email, recorded_by: owner.id, same_hash: true, same_time: true },
      { channel: "sms", state: "withdrawn", source: "manual", method: "ביקש להסיר", copied_from: latestSms, recorded_by: owner.id, same_hash: true, same_time: true },
    ]);
    expect(await current("contact", contactId)).toEqual([
      { channel: "email", state: "granted" },
      { channel: "sms", state: "withdrawn" },
    ]);
    // the lead keeps its own history
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.consents where lead_id = $1", [lead]))).toBe(3);
    // a client cannot claim a copy
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.consents (organization_id, contact_id, channel, state, source, method, copied_from) values ($1, $2, 'sms', 'granted', 'manual', 'x', $3)", [org, contactId, email])))).code).toBe("42501");
  });

  it("a consent recorded on a sample lead or contact keeps it", async () => {
    const o = await createUser("cns2-sample");
    const sorg = await createOrg(o.id);
    await asUser(o.id, (q) => q("select public.sample_data_add($1)", [sorg]));
    const sample = await asUser(o.id, async (q) =>
      (await q<{ record_type: string; record_id: string }>("select record_type, record_id from public.sample_data_records($1)", [sorg])).rows,
    );
    const ids = (t: string) => sample.filter((r) => r.record_type === t).map((r) => r.record_id);
    // sample records have no phone or email: a server writer records it (a person's entry needs an address)
    const [leadId] = ids("lead");
    const [contactId] = ids("contact");
    expect(leadId).toBeDefined();
    expect(contactId).toBeDefined();
    for (const [col, id] of [["lead_id", leadId], ["contact_id", contactId]] as const) {
      await asAdmin((q) => q(`insert into public.consents (organization_id, ${col}, channel, state, source) values ($1, $2, 'sms', 'granted', 'api')`, [sorg, id]));
    }
    const untouched = ids("lead").find((id) => id !== leadId);
    await asUser(o.id, (q) => q("select public.sample_data_remove($1)", [sorg]));
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1", [leadId]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1", [contactId]))).toBe(1);
    // and an untouched sample lead still goes
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1", [untouched]))).toBe(0);
  });

  it("without the hash key the consent is still recorded, and nothing can be checked", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "בלי מפתח", phone: "050-2220005" });
    await setKey(null);
    try {
      const id = await add({ lead }, "sms", "withdrawn", "ביקש להסיר");
      expect(await asAdmin(async (q) => (await q("select address_hash from public.consents where id = $1", [id])).rows[0].address_hash)).toBeNull();
      expect(await asUser(owner.id, async (q) => (await q("select current_address from public.consent_current($1, 'lead', $2)", [org, lead])).rows)).toEqual([
        { current_address: null },
      ]);
      expect(await asAdmin(async (q) => (await q("select app.consent_suppressed($1, 'sms', '+972502220005') as s", [org])).rows[0].s)).toBeNull();
      expect(await asAdmin(async (q) => (await q("select app.consent_address_hash($1, 'phone', '+972502220005') as h", [org])).rows[0].h)).toBeNull();
      expect(await asAdmin(async (q) => (await q("select app.consent_key_present() as k")).rows[0].k)).toBe(false);
      // nothing to fill while the key is missing
      expect(await asAdmin(async (q) => (await q<{ n: number }>("select app.consent_backfill_hashes() as n")).rows[0].n)).toBe(0);
    } finally {
      await setKey(KEY);
    }
    const suppressed = async () => asAdmin(async (q) => (await q("select app.consent_suppressed($1, 'sms', '050-2220005') as s", [org])).rows[0].s);
    expect(await asAdmin(async (q) => (await q("select app.consent_key_present() as k")).rows[0].k)).toBe(true);
    // the key is back, the opt-out is not hashed yet: fail closed
    expect(await suppressed()).toBeNull();
    // the hourly backfill fills it from the record's address of today
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select app.consent_backfill_hashes() as n")).rows[0].n)).toBeGreaterThanOrEqual(1);
    expect(await suppressed()).toBe(true);
    expect(await asUser(owner.id, async (q) => (await q("select current_address from public.consent_current($1, 'lead', $2)", [org, lead])).rows)).toEqual([
      { current_address: true },
    ]);
  });

  it("a conversion copy of an entry made without the key keeps no hash", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "המרה בלי מפתח", phone: "050-2220008" });
    await setKey(null);
    try {
      await add({ lead }, "sms", "granted");
    } finally {
      await setKey(KEY);
    }
    const contactId = await asUser(owner.id, async (q) =>
      (await q<{ r: { contact_id: string } }>("select public.convert_lead($1, false) as r", [lead])).rows[0].r.contact_id,
    );
    expect(await asAdmin(async (q) => (await q("select address_hash from public.consents where contact_id = $1", [contactId])).rows)).toEqual([
      { address_hash: null },
    ]);
    // the backfill then decides, from the contact's address
    await asAdmin((q) => q("select app.consent_backfill_hashes()"));
    expect(await asAdmin(async (q) => (await q("select address_hash from public.consents where contact_id = $1", [contactId])).rows[0].address_hash)).toBe(
      sha(`${org}:phone:+972502220008`),
    );
  });

  it("only the server asks whether the key is there or fills hashes", async () => {
    for (const fn of ["app.consent_key_present()", "app.consent_backfill_hashes()"]) {
      expect((await pgError(asUser(owner.id, (q) => q(`select ${fn}`)))).code, fn).toBe("42501");
    }
  });

  it("a person who opted out is still matched after the record was purged, erased and created again", async () => {
    const contact = await newContact("first_name, phone", ["יוסי", "050-2220006"]);
    await add({ contact }, "sms", "granted");
    await add({ contact }, "sms", "withdrawn", "ענה הסר");
    await asAdmin((q) => q("delete from public.contacts where id = $1", [contact]));
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    const again = await newContact("first_name, phone", ["יוסי שוב", "050-2220006"]);
    const suppressed = (channel: string, value: string, o = org) =>
      asAdmin(async (q) => (await q<{ s: boolean | null }>("select app.consent_suppressed($1, $2, $3) as s", [o, channel, value])).rows[0].s);
    expect(again).not.toBe(contact);
    expect(await suppressed("sms", "+972502220006")).toBe(true);
    // the raw value is normalized like the stored one
    expect(await suppressed("sms", "050-2220006")).toBe(true);
    expect(await suppressed("sms", " 050 222 0006 ")).toBe(true);
    // the erasure was at the person's request: calls are marked "do not contact" too
    expect(await suppressed("phone", "+972502220006")).toBe(true);
    // another organization does not see it (another hash)
    const other = await createUser("cns2-other");
    const org2 = await createOrg(other.id);
    expect(await suppressed("sms", "+972502220006", org2)).toBe(false);
    // the erasure was the person's request: a mark on the new record does not lift it, only their own form consent
    expect((await pgError(add({ contact: again }, "sms", "granted", "הסכים מחדש בכתב"))).hint).toBe("consent:erasure_block");
    await asAdmin((q) => q("insert into public.consents (organization_id, contact_id, channel, state, source) values ($1, $2, 'sms', 'granted', 'form')", [org, again]));
    expect(await suppressed("sms", "+972502220006")).toBe(false);
    // only the server asks
    expect((await pgError(asUser(owner.id, (q) => q("select app.consent_suppressed($1, 'sms', '+972502220006')", [org])))).code).toBe("42501");
  });

  it("the full export's column list for consents is readable by a client", async () => {
    const { EXPORT_COLUMNS } = await import("@/features/imports/export-build");
    expect(EXPORT_COLUMNS.consents).not.toContain("address_hash");
    // exactly the columns a client may select: a new column cannot be left out of the export silently
    const granted = await asAdmin(async (q) =>
      (
        await q<{ column_name: string }>(
          "select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'consents' and grantee = 'authenticated' and privilege_type = 'SELECT'",
        )
      ).rows.map((r) => r.column_name),
    );
    expect([...(EXPORT_COLUMNS.consents ?? "").split(",").map((c) => c.trim())].sort()).toEqual([...granted].sort());
    await asUser(owner.id, (q) => q(`select ${EXPORT_COLUMNS.consents} from public.consents where organization_id = $1`, [org]));
  });
});

// A hash missing because the key was missing is made later from the address the entry was
// written for (app.consent_pending_address), never from the record's address of today.
describe("consents written without the hash key", () => {
  type Ctx = { o: U; org: string };
  const fresh = async (label: string): Promise<Ctx> => {
    const o = await createUser(label);
    return { o, org: await createOrg(o.id) };
  };
  const optOut = (c: Ctx, subject: { lead?: string; contact?: string }, channel = "sms", state = "withdrawn") =>
    asUser(c.o.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method) values ($1, $2, $3, $4, $5, 'manual', 'x') returning id",
          [c.org, subject.lead ?? null, subject.contact ?? null, channel, state],
        )
      ).rows[0].id,
    );
  const withoutKey = async <T>(fn: () => Promise<T>): Promise<T> => {
    await setKey(null);
    try {
      return await fn();
    } finally {
      await setKey(KEY);
    }
  };
  const suppressed = (org: string, channel: string, value: string) =>
    asAdmin(async (q) => (await q<{ s: boolean | null }>("select app.consent_suppressed($1, $2, $3) as s", [org, channel, value])).rows[0].s);
  const backfill = () => asAdmin(async (q) => (await q<{ n: number }>("select app.consent_backfill_hashes() as n")).rows[0].n);
  const contact = (c: Ctx, phone: string | null) =>
    asUser(c.o.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone) values ($1, 'x', $2) returning id", [c.org, phone])).rows[0].id);

  it("a phone changed before the backfill: the old number stays opted out, the new one not", async () => {
    const c = await fresh("cns3-change");
    const lead = await insertLead(c.o.id, c.org, { phone: "050-3330001" });
    await withoutKey(() => optOut(c, { lead }));
    expect(await asAdmin(async (q) => (await q("select app.consent_unhashed_count($1) as n", [c.org])).rows[0].n)).toEqual({ sms: 1 });
    await asUser(c.o.id, (q) => q("update public.leads set phone = '050-3330002' where id = $1", [lead]));
    expect(await suppressed(c.org, "sms", "050-3330001")).toBeNull();
    expect(await backfill()).toBeGreaterThanOrEqual(1);
    expect(await suppressed(c.org, "sms", "050-3330001")).toBe(true);
    expect(await suppressed(c.org, "sms", "050-3330002")).toBe(false);
    expect(await asAdmin(async (q) => (await q("select app.consent_unhashed_count($1) as n", [c.org])).rows[0].n)).toEqual({});
    // the stored address is blanked once hashed
    expect(await asAdmin((q) => count(q, "select 1 from app.consent_pending_address where organization_id = $1 and value is not null", [c.org]))).toBe(0);
  });

  it("a merge before the backfill: the duplicate's number stays opted out, the kept one not", async () => {
    const c = await fresh("cns3-merge");
    const keep = await insertLead(c.o.id, c.org, { full_name: "נשאר", phone: "050-3330012" });
    const dup = await insertLead(c.o.id, c.org, { full_name: "כפול", phone: "050-3330011" });
    await withoutKey(() => optOut(c, { lead: dup }));
    await asUser(c.o.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [c.org, keep, dup]));
    await backfill();
    expect(await suppressed(c.org, "sms", "050-3330011")).toBe(true);
    expect(await suppressed(c.org, "sms", "050-3330012")).toBe(false);
  });

  it("a conversion into an existing contact with another phone: the copy keeps the lead's number", async () => {
    const c = await fresh("cns3-convert");
    const lead = await insertLead(c.o.id, c.org, { phone: "050-3330021" });
    const existing = await contact(c, "050-3330022");
    await withoutKey(() => optOut(c, { lead }));
    // the way a merge converts a lead into a contact that already exists
    await asAdmin((q) => q("update public.leads set converted_contact_id = $2, converted_at = now() where id = $1", [lead, existing]));
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where contact_id = $1 and address_hash is null", [existing]))).toBe(1);
    await backfill();
    const hashes = await asAdmin(async (q) =>
      (await q<{ address_hash: string }>("select address_hash from public.consents where organization_id = $1 order by seq", [c.org])).rows.map((r) => r.address_hash),
    );
    expect(hashes).toEqual([sha(`${c.org}:phone:+972503330021`), sha(`${c.org}:phone:+972503330021`)]);
    expect(await suppressed(c.org, "sms", "050-3330021")).toBe(true);
    expect(await suppressed(c.org, "sms", "050-3330022")).toBe(false);
  });

  it("a purged record is repaired by the backfill", async () => {
    const c = await fresh("cns3-purge");
    const lead = await insertLead(c.o.id, c.org, { phone: "050-3330031" });
    const id = await withoutKey(() => optOut(c, { lead }));
    // a client may not write the hash; the server may not write a wrong one
    expect((await pgError(asUser(c.o.id, (q) => q("update public.consents set address_hash = 'x' where id = $1", [id])))).code).toBe("42501");
    expect((await pgError(asAdmin((q) => q("update public.consents set address_hash = 'x' where id = $1", [id])))).hint).toBe("consent:append_only");
    await asAdmin((q) => q("delete from public.leads where id = $1", [lead]));
    await backfill();
    expect(await suppressed(c.org, "sms", "050-3330031")).toBe(true);
  });

  it("an opt-out whose stored address is gone keeps its channel closed in its organization only", async () => {
    const c = await fresh("cns3-closed");
    const lead = await insertLead(c.o.id, c.org, { phone: "050-3330032" });
    const id = await withoutKey(() => optOut(c, { lead }));
    // no path in the product blanks it before it is hashed any more; the rule still holds if one ever does
    await asAdmin((q) => q("update app.consent_pending_address set value = null where consent_id = $1", [id]));
    await backfill();
    expect(await suppressed(c.org, "sms", "050-3330032")).toBeNull();
    expect(await suppressed(c.org, "sms", "050-3339999")).toBeNull();
    expect(await suppressed(c.org, "phone", "050-3330032")).toBe(false);
    const other = await fresh("cns3-closed-other");
    expect(await suppressed(other.org, "sms", "050-3330032")).toBe(false);
  });

  it("an entry written with no address for the channel matches nobody and closes nothing", async () => {
    const c = await fresh("cns3-noaddr");
    const lead = await insertLead(c.o.id, c.org, { phone: null, email: null });
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'sms', 'withdrawn', 'api')", [c.org, lead]));
    expect(await asAdmin(async (q) => (await q("select hash_version, address_hash from public.consents where lead_id = $1", [lead])).rows)).toEqual([
      { hash_version: 0, address_hash: null },
    ]);
    expect(await suppressed(c.org, "sms", "050-3330041")).toBe(false);
    expect(await asAdmin(async (q) => (await q("select app.consent_unhashed_count($1) as n", [c.org])).rows[0].n)).toEqual({});
  });

  it("a later 'unknown' lifts no opt-out; an unknown channel cannot be checked; a supplied hash is ignored", async () => {
    const c = await fresh("cns3-unknown");
    const lead = await insertLead(c.o.id, c.org, { phone: "050-3330051" });
    await optOut(c, { lead });
    await asAdmin((q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, address_hash) values ($1, $2, 'sms', 'unknown', 'import', 'forged')", [c.org, lead]),
    );
    expect(await suppressed(c.org, "sms", "050-3330051")).toBe(true);
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where address_hash = 'forged'"))).toBe(0);
    expect(await suppressed(c.org, "fax", "050-3330051")).toBeNull();
    expect(await suppressed(c.org, "SMS", "050-3330051")).toBeNull();
  });

  it("an erasure after the key is set hashes the waiting entry first", async () => {
    const c = await fresh("cns3-erase-key");
    const gone = await contact(c, "050-3330061");
    const id = await withoutKey(() => optOut(c, { contact: gone }));
    await asAdmin((q) => q("delete from public.contacts where id = $1", [gone]));
    // with the key present it is done at once, as before
    expect(await asUser(c.o.id, async (q) => (await q<{ n: number }>("select public.audit_erase_record($1, 'contacts', $2) as n", [c.org, gone])).rows[0].n)).toBeGreaterThanOrEqual(0);
    expect(await asAdmin(async (q) => (await q("select address_hash from public.consents where id = $1", [id])).rows[0].address_hash)).toBe(
      sha(`${c.org}:phone:+972503330061`),
    );
    expect(await asAdmin(async (q) => (await q("select value from app.consent_pending_address where consent_id = $1", [id])).rows)).toEqual([{ value: null }]);
    expect(await suppressed(c.org, "sms", "050-3330061")).toBe(true);
    expect(await suppressed(c.org, "sms", "050-3339999")).toBe(false);
  });

  it("an opt-out written without an address covers the address the record gets later", async () => {
    const c = await fresh("cns3-later");
    const lead = await insertLead(c.o.id, c.org, { phone: null, email: null });
    const server = (channel: string, state: string) =>
      asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, $3, $4, 'unsubscribe')", [c.org, lead, channel, state]));
    await server("email", "withdrawn");
    await server("sms", "denied");
    await server("whatsapp", "granted");
    expect(await asUser(c.o.id, async (q) => (await q("select channel, current_address from public.consent_current($1, 'lead', $2) order by channel", [c.org, lead])).rows)).toEqual([
      { channel: "email", current_address: false },
      { channel: "sms", current_address: false },
      { channel: "whatsapp", current_address: false },
    ]);
    await asUser(c.o.id, (q) => q("update public.leads set email = 'Later@Example.test' where id = $1", [lead]));
    expect(await suppressed(c.org, "email", "later@example.test")).toBe(true);
    await asUser(c.o.id, (q) => q("update public.leads set phone = '050-3330071' where id = $1", [lead]));
    expect(await suppressed(c.org, "sms", "050-3330071")).toBe(true);
    // a version-0 'granted' adds nothing
    expect(await suppressed(c.org, "whatsapp", "050-3330071")).toBe(false);
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where lead_id = $1 and channel = 'whatsapp'", [lead]))).toBe(1);
    // the copies keep the original's state, source and time
    const copies = await asAdmin(async (q) =>
      (
        await q("select c.channel, c.state, c.source, c.created_at = o.created_at as same_time from public.consents c join public.consents o on o.id = c.copied_from where c.lead_id = $1 order by c.channel", [lead])
      ).rows,
    );
    expect(copies).toEqual([
      { channel: "email", state: "withdrawn", source: "unsubscribe", same_time: true },
      { channel: "sms", state: "denied", source: "unsubscribe", same_time: true },
    ]);
  });

  it("a server writer cannot date an entry ahead", async () => {
    const c = await fresh("cns3-future");
    const lead = await insertLead(c.o.id, c.org, { phone: "050-3330081" });
    // a 'granted' dated a year ahead is stored as of now, so the opt-out written after it wins
    await asAdmin((q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, created_at) values ($1, $2, 'sms', 'granted', 'api', now() + interval '1 year')", [c.org, lead]),
    );
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where lead_id = $1 and created_at > now()", [lead]))).toBe(0);
    await optOut(c, { lead });
    expect(await suppressed(c.org, "sms", "050-3330081")).toBe(true);
    // backdating stays possible (an import of old consents)
    const lead2 = await insertLead(c.o.id, c.org, { phone: "050-3330082" });
    await asAdmin((q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, created_at) values ($1, $2, 'sms', 'granted', 'import', '2020-01-01')", [c.org, lead2]),
    );
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where lead_id = $1 and created_at = '2020-01-01'", [lead2]))).toBe(1);
  });

  it("a copy left without an address takes its source's hash in the backfill", async () => {
    const c = await fresh("cns3-race");
    const lead = await insertLead(c.o.id, c.org, { phone: "050-3330091" });
    const existing = await contact(c, "050-3330092");
    await withoutKey(async () => {
      await optOut(c, { lead });
      await asAdmin((q) => q("update public.leads set converted_contact_id = $2, converted_at = now() where id = $1", [lead, existing]));
    });
    const copy = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.consents where contact_id = $1", [existing])).rows[0].id);
    // the race: the copy's stored address is gone before the backfill
    await asAdmin((q) => q("update app.consent_pending_address set value = null where consent_id = $1", [copy]));
    await backfill();
    expect(await asAdmin(async (q) => (await q("select address_hash from public.consents where id = $1", [copy])).rows[0].address_hash)).toBe(
      sha(`${c.org}:phone:+972503330091`),
    );
  });

  it("an erasure while the key is missing is paused, marks the person withdrawn and completes later", async () => {
    const c = await fresh("cns3-pause");
    const gone = await contact(c, "050-3330101");
    const erase = () => asUser(c.o.id, async (q) => (await q<{ n: number }>("select public.audit_erase_record($1, 'contacts', $2) as n", [c.org, gone])).rows[0].n);
    const original = await withoutKey(async () => {
      const id = await optOut(c, { contact: gone }, "sms", "granted");
      await asAdmin((q) => q("delete from public.contacts where id = $1", [gone]));
      expect(await erase()).toBe(-1);
      return id;
    });
    // nothing erased yet
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and action = 'erase'", [gone]))).toBe(0);
    expect(await asAdmin(async (q) => (await q("select method from public.consents where id = $1", [original])).rows[0].method)).toBe("x");
    // marked withdrawn on every channel whose address is known (the phone; no email was known)
    expect(
      await asAdmin(async (q) =>
        (await q("select channel, state, source, address_hash from public.consents where subject_id = $1 and source = 'erasure' order by channel", [gone])).rows,
      ),
    ).toEqual([
      { channel: "phone", state: "withdrawn", source: "erasure", address_hash: null },
      { channel: "sms", state: "withdrawn", source: "erasure", address_hash: null },
      { channel: "whatsapp", state: "withdrawn", source: "erasure", address_hash: null },
    ]);
    // platform staff can see it
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'consent_erasure_pending' and organization_id = $1", [c.org]))).toBe(1);
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select app.pending_erasure_count() as n")).rows[0].n)).toBeGreaterThanOrEqual(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.pending_erasures where record_id = $1 and completed_at is null", [gone]))).toBe(1);

    // the key is there: the backfill hashes, then completes the erasure and tells the owner
    await backfill();
    expect(await asAdmin((q) => count(q, "select 1 from app.pending_erasures where record_id = $1 and completed_at is not null", [gone]))).toBe(1);
    expect(await asAdmin(async (q) => (await q("select actor_id from public.audit_log where entity_id = $1 and action = 'erase'", [gone])).rows)).toEqual([
      { actor_id: c.o.id },
    ]);
    expect(await asAdmin(async (q) => (await q("select method from public.consents where id = $1", [original])).rows[0].method)).toBeNull();
    expect(
      await asAdmin(async (q) => (await q("select type, title, body from public.notifications where organization_id = $1 and title = 'המחיקה שביקשתם הושלמה'", [c.org])).rows),
    ).toEqual([{ type: "system", title: "המחיקה שביקשתם הושלמה", body: "איש קשר" }]);
    expect(await suppressed(c.org, "sms", "050-3330101")).toBe(true);
    expect(await suppressed(c.org, "whatsapp", "050-3330101")).toBe(true);
    expect(await suppressed(c.org, "sms", "050-3339999")).toBe(false);
    expect(await asAdmin(async (q) => (await q("select app.consent_unhashed_count($1) as n", [c.org])).rows[0].n)).toEqual({});
    expect(await asAdmin((q) => count(q, "select 1 from app.consent_pending_address where organization_id = $1 and value is not null", [c.org]))).toBe(0);
    // completing again does nothing
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select app.complete_pending_erasures() as n")).rows[0].n)).toBe(0);
  });

  it("the pause also marks an address that has no consent entry, from the deleted record", async () => {
    const c = await fresh("cns3-pause-snapshot");
    const lead = await insertLead(c.o.id, c.org, { phone: "050-3330111", email: "snap@example.test" });
    await withoutKey(async () => {
      await optOut(c, { lead }, "email", "granted");
      await asAdmin((q) => q("delete from public.leads where id = $1", [lead]));
      expect(await asUser(c.o.id, async (q) => (await q<{ n: number }>("select public.audit_erase_record($1, 'leads', $2) as n", [c.org, lead])).rows[0].n)).toBe(-1);
    });
    expect(
      await asAdmin(async (q) => (await q("select channel, copied_from is null as from_record from public.consents where subject_id = $1 and source = 'erasure' order by channel", [lead])).rows),
    ).toEqual([
      { channel: "email", from_record: false },
      { channel: "phone", from_record: true },
      { channel: "sms", from_record: true },
      { channel: "whatsapp", from_record: true },
    ]);
    // a marked row is new now, not its source's time
    expect(
      await asAdmin((q) => count(q, "select 1 from public.consents c join public.consents s on s.id = c.copied_from where c.subject_id = $1 and c.source = 'erasure' and c.created_at <= s.created_at", [lead])),
    ).toBe(0);
    await backfill();
    expect(await asAdmin((q) => count(q, "select 1 from app.pending_erasures where record_id = $1 and completed_at is not null", [lead]))).toBe(1);
    expect(await suppressed(c.org, "sms", "050-3330111")).toBe(true);
    expect(await suppressed(c.org, "phone", "050-3330111")).toBe(true);
    expect(await suppressed(c.org, "email", "snap@example.test")).toBe(true);
  });

  it("the pause writes nothing for a kind the record had no address of", async () => {
    const c = await fresh("cns3-pause-none");
    const lead = await insertLead(c.o.id, c.org, { phone: "050-3330121", email: null });
    await withoutKey(async () => {
      await optOut(c, { lead });
      await asUser(c.o.id, (q) => q("update public.leads set phone = null where id = $1", [lead]));
      await asAdmin((q) => q("delete from public.leads where id = $1", [lead]));
      await asUser(c.o.id, (q) => q("select public.audit_erase_record($1, 'leads', $2)", [c.org, lead]));
    });
    // the phone channels come from the opt-out's own address; no email was ever known
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where subject_id = $1 and source = 'erasure' and channel = 'email'", [lead]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where subject_id = $1 and source = 'erasure'", [lead]))).toBe(3);
  });

  it("asking again while it waits changes nothing", async () => {
    const c = await fresh("cns3-pause-again");
    const gone = await contact(c, "050-3330131");
    const other = await addMember(c.org, c.o.id, "admin", "cns3-admin2");
    await withoutKey(async () => {
      await optOut(c, { contact: gone });
      await asAdmin((q) => q("delete from public.contacts where id = $1", [gone]));
      await asUser(c.o.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [c.org, gone]));
      const before = await asAdmin(async (q) => (await q("select requested_at, requested_by from app.pending_erasures where record_id = $1", [gone])).rows[0]);
      const rows = await asAdmin((q) => count(q, "select 1 from public.consents where subject_id = $1", [gone]));
      expect(await asUser(other.id, async (q) => (await q<{ n: number }>("select public.audit_erase_record($1, 'contacts', $2) as n", [c.org, gone])).rows[0].n)).toBe(-1);
      expect(await asAdmin(async (q) => (await q("select requested_at, requested_by from app.pending_erasures where record_id = $1", [gone])).rows[0])).toEqual(before);
      expect(await asAdmin((q) => count(q, "select 1 from public.consents where subject_id = $1", [gone]))).toBe(rows);
      expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'consent_erasure_pending' and organization_id = $1", [c.org]))).toBe(1);
    });
    await backfill();
  });

  it("a record-less entry is only a server's 'withdrawn' of a paused erasure", async () => {
    const c = await fresh("cns3-linkless");
    const lead = await insertLead(c.o.id, c.org, { phone: "050-3330141" });
    const id = await optOut(c, { lead });
    for (const [state, source] of [["granted", "erasure"], ["granted", "api"], ["withdrawn", "api"]]) {
      const err = await pgError(
        asAdmin((q) => q("insert into public.consents (organization_id, channel, state, source, copied_from) values ($1, 'sms', $2, $3, $4)", [c.org, state, source, id])),
      );
      expect(err.hint ?? err.code, `${state}/${source}`).toBe("consent:subject");
    }
    // the check holds for linked rows too
    const clean = await insertLead(c.o.id, c.org, { phone: "050-3330142" });
    expect((await pgError(asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'sms', 'granted', 'erasure')", [c.org, clean])))).code).toBe(
      "23514",
    );
  });
});

describe("platform consent health", () => {
  it("is for platform owner and support, and counts what needs care", async () => {
    const staff = async (label: string, role: string | null) => {
      const u = await createUser(label);
      if (role) await asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2)", [u.id, role]));
      return u;
    };
    const health = (id: string) => asMfaUser(id, async (q) => (await q<{ r: Record<string, number | boolean> }>("select public.platform_consent_health() as r")).rows[0].r);
    const support = await staff("cns-support", "support");
    for (const u of [await staff("cns-nobody", null), await staff("cns-readonly", "readonly"), await staff("cns-finance", "finance")]) {
      expect((await pgError(health(u.id))).code).toBe("42501");
    }
    // without the second step either
    expect((await pgError(asUser(support.id, (q) => q("select public.platform_consent_health()"))))).toHaveProperty("code", "42501");

    // a completion that keeps failing: retried up to 24 times, logged on the first and the last
    const o = await createUser("cns-health-org");
    const org = await createOrg(o.id);
    const lead = await insertLead(o.id, org, { phone: "050-3330151" });
    await asAdmin((q) => q("insert into app.pending_erasures (organization_id, record_type, record_id, requested_by) values ($1, 'leads', $2, $3)", [org, lead, o.id]));
    const before = await health(support.id);
    expect(before.key_present).toBe(true);
    await asAdmin((q) => q("select app.complete_pending_erasures()"));
    const logged = () => asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'consent_erasure_failed' and organization_id = $1", [org]));
    expect(await logged()).toBe(1);
    await asAdmin((q) => q("select app.complete_pending_erasures()"));
    expect(await logged()).toBe(1);
    await asAdmin((q) => q("update app.pending_erasures set attempts = 23 where record_id = $1", [lead]));
    await asAdmin((q) => q("select app.complete_pending_erasures()"));
    expect(await logged()).toBe(2);
    await asAdmin((q) => q("select app.complete_pending_erasures()"));
    expect(await asAdmin(async (q) => (await q("select attempts from app.pending_erasures where record_id = $1", [lead])).rows[0].attempts)).toBe(24);
    const after = await health(support.id);
    expect(Number(after.erasures_stopped)).toBe(Number(before.erasures_stopped) + 1);
    expect(Number(after.erasure_failures_last_7d)).toBe(Number(before.erasure_failures_last_7d) + 2);
    expect(typeof after.pending_erasures).toBe("number");
    expect(typeof after.unhashed_optouts_total).toBe("number");
    // the key missing shows too
    await setKey(null);
    try {
      expect((await health(support.id)).key_present).toBe(false);
    } finally {
      await setKey(KEY);
    }
  });
});

// Owner's rules of 13 October 2026: who may lift an opt-out, and an erasure at the person's request.
describe("lifting an opt-out", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U;
  let org: string;
  beforeAll(async () => {
    owner = await createUser("cns4-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "cns4-admin");
    manager = await addMember(org, owner.id, "manager", "cns4-manager");
    member = await addMember(org, owner.id, "member", "cns4-member");
    viewer = await addMember(org, owner.id, "viewer", "cns4-viewer");
  });
  const lead = (u: U, phone: string) => insertLead(u.id, org, { phone });
  const mark = (u: U, leadId: string, state: string, lift?: [string | null, string | null]) =>
    asUser(u.id, (q) =>
      q(
        "insert into public.consents (organization_id, lead_id, channel, state, source, method, lift_method, lift_note) values ($1, $2, 'sms', $3, 'manual', 'בשיחה', $4, $5)",
        [org, leadId, state, lift?.[0] ?? null, lift?.[1] ?? null],
      ),
    );
  const server = (leadId: string, state: string, source: string) =>
    asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'sms', $3, $4)", [org, leadId, state, source]));
  const suppressed = (value: string) =>
    asAdmin(async (q) => (await q<{ s: boolean | null }>("select app.consent_suppressed($1, 'sms', $2) as s", [org, value])).rows[0].s);

  it("a form consent lifts an ordinary opt-out", async () => {
    const l = await lead(member, "050-4440001");
    await mark(member, l, "withdrawn");
    expect(await suppressed("050-4440001")).toBe(true);
    await server(l, "granted", "form");
    expect(await suppressed("050-4440001")).toBe(false);
  });

  it("an owner or admin lifts it with a method and a note, and it is audited", async () => {
    for (const [u, phone] of [[owner, "050-4440002"], [admin, "050-4440003"]] as const) {
      const l = await lead(owner, phone);
      await mark(owner, l, "withdrawn");
      await mark(u, l, "granted", ["signed_form", "חתם בכנס"]);
      expect(await suppressed(phone)).toBe(false);
      expect(
        await asAdmin(async (q) => (await q("select actor_id, changes from public.audit_log where entity_id = $1 and action = 'consent_lift'", [l])).rows),
      ).toEqual([{ actor_id: u.id, changes: { channel: "sms", lift_method: "signed_form", lift_note: "חתם בכנס" } }]);
    }
  });

  it("a lift without its method or note is refused", async () => {
    const l = await lead(owner, "050-4440004");
    await mark(owner, l, "withdrawn");
    expect((await pgError(mark(owner, l, "granted"))).hint).toBe("consent:optout_locked");
    expect((await pgError(mark(owner, l, "granted", ["recorded_call", "  "]))).hint).toBe("consent:lift_note");
    expect((await pgError(mark(owner, l, "granted", [null, "הערה"]))).hint).toBe("consent:lift_note");
    expect((await pgError(mark(owner, l, "granted", ["phone_call", "הערה"]))).code).toBe("23514");
    expect(await suppressed("050-4440004")).toBe(true);
  });

  it("a member, manager or viewer cannot lift it, not even through another record with the same phone", async () => {
    const l = await lead(member, "050-4440005");
    await mark(member, l, "withdrawn");
    const other = await lead(member, "050-4440005");
    // on their own record it says why; through another record with the same phone only that the address is blocked
    expect((await pgError(mark(member, l, "granted"))).hint).toBe("consent:optout_locked");
    for (const u of [member, manager]) {
      expect((await pgError(mark(u, other, "granted"))).hint, u.email).toBe("consent:address_blocked");
      expect((await pgError(mark(u, other, "granted", ["signed_form", "x"]))).hint, u.email).toBe("consent:lift_admin");
    }
    expect((await pgError(mark(viewer, other, "granted"))).hint).toBe("consent:address_blocked");
    expect(await suppressed("050-4440005")).toBe(true);
  });

  it("an import or an automation cannot lift it", async () => {
    const l = await lead(member, "050-4440006");
    await mark(member, l, "denied");
    for (const source of ["import", "api"]) {
      expect((await pgError(server(l, "granted", source))).hint, source).toBe("consent:optout_locked");
    }
    expect(await suppressed("050-4440006")).toBe(true);
  });

  it("an erasure at the person's request blocks marketing until their own form consent", async () => {
    const l = await lead(owner, "050-4440007");
    await asAdmin((q) => q("update public.leads set email = 'erased@example.test' where id = $1", [l]));
    await asAdmin((q) => q("delete from public.leads where id = $1", [l]));
    expect(await asUser(owner.id, async (q) => (await q<{ n: number }>("select public.audit_erase_request($1, 'leads', $2, true) as n", [org, l])).rows[0].n)).toBeGreaterThanOrEqual(0);
    // do not contact, on every channel of the phone and on the email, although nothing was recorded before
    expect(await asAdmin(async (q) => (await q("select channel from public.consents where subject_id = $1 and source = 'erasure' order by channel", [l])).rows)).toEqual([
      { channel: "email" },
      { channel: "phone" },
      { channel: "sms" },
      { channel: "whatsapp" },
    ]);
    expect(await suppressed("050-4440007")).toBe(true);
    expect(await asAdmin(async (q) => (await q("select app.consent_suppressed($1, 'email', 'Erased@Example.test') as s", [org])).rows[0].s)).toBe(true);
    // a re-import brings nobody back into marketing
    const again = await lead(owner, "050-4440007");
    expect((await pgError(server(again, "granted", "import"))).hint).toBe("consent:erasure_block");
    expect((await pgError(server(again, "granted", "api"))).hint).toBe("consent:erasure_block");
    // nor an owner's manual lift
    expect((await pgError(mark(owner, again, "granted", ["written_message", "ביקש בכתב"]))).hint).toBe("consent:erasure_block");
    expect(await suppressed("050-4440007")).toBe(true);
    // the person's own new consent in a form does
    await server(again, "granted", "form");
    expect(await suppressed("050-4440007")).toBe(false);
  });

  it("an erasure not at the person's request adds nothing, and an existing opt-out stays", async () => {
    const l = await lead(owner, "050-4440008");
    await mark(owner, l, "withdrawn");
    const l2 = await lead(owner, "050-4440009");
    for (const id of [l, l2]) {
      await asAdmin((q) => q("delete from public.leads where id = $1", [id]));
      await asUser(owner.id, (q) => q("select public.audit_erase_request($1, 'leads', $2, false)", [org, id]));
      expect(await asAdmin((q) => count(q, "select 1 from public.consents where subject_id = $1 and source = 'erasure'", [id]))).toBe(0);
    }
    expect(await suppressed("050-4440008")).toBe(true);
    expect(await suppressed("050-4440009")).toBe(false);
    expect(await asAdmin(async (q) => (await q("select person_request from app.pending_erasures where record_id = $1", [l2])).rows)).toEqual([{ person_request: false }]);
  });

  it("a new inquiry from an erased person is taken as usual", async () => {
    const l = await lead(owner, "050-4440010");
    await asAdmin((q) => q("delete from public.leads where id = $1", [l]));
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'leads', $2)", [org, l]));
    const token = await asUser(owner.id, async (q) => (await q<{ token: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס') returning token", [org])).rows[0].token);
    await asService((q) => q("select public.intake_submit($1, 'form', $2)", [token, JSON.stringify({ full_name: "פונה שוב", phone: "050-4440010" })]));
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and phone_e164 = '+972504440010'", [org]))).toBe(1);
    // the block stays for marketing
    expect(await suppressed("050-4440010")).toBe(true);
  });

  it("the lock says nothing to someone who may not write the record: the policy refuses first", async () => {
    const l = await lead(member, "050-4440011");
    await mark(member, l, "withdrawn");
    // another organization, aiming at this one
    const stranger = await createUser("cns4-stranger");
    await createOrg(stranger.id);
    const err = await pgError(
      asUser(stranger.id, (q) =>
        q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'x')", [org, l]),
      ),
    );
    expect(err.code).toBe("42501");
    expect(err.hint ?? "").not.toMatch(/^consent:/);
    // in the same organization, a record the member may not read
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const err2 = await pgError(mark(member, await lead(admin, "050-4440012"), "granted"));
      const hidden = await lead(admin, "050-4440011");
      const err3 = await pgError(mark(member, hidden, "granted"));
      for (const e of [err2, err3]) {
        expect(e.code).toBe("42501");
        expect(e.hint ?? "").not.toMatch(/^consent:/);
      }
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a lift of nothing is refused", async () => {
    const l = await lead(owner, "050-4440013");
    expect((await pgError(mark(owner, l, "granted", ["signed_form", "x"]))).hint).toBe("consent:lift_nothing");
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and action = 'consent_lift'", [l]))).toBe(0);
  });

  it("an erasure empties a lift's note too", async () => {
    const l = await lead(owner, "050-4440014");
    await mark(owner, l, "withdrawn");
    await mark(owner, l, "granted", ["written_message", "שלח מייל ב-12.10"]);
    await asAdmin((q) => q("delete from public.leads where id = $1", [l]));
    await asUser(owner.id, (q) => q("select public.audit_erase_request($1, 'leads', $2, false)", [org, l]));
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where subject_id = $1 and lift_note is not null", [l]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and changes::text like '%12.10%'", [l]))).toBe(0);
  });

  it("asking again after the erasure was completed adds no second mark", async () => {
    const l = await lead(owner, "050-4440015");
    await mark(owner, l, "withdrawn");
    await asAdmin((q) => q("delete from public.leads where id = $1", [l]));
    const marks = () => asAdmin((q) => count(q, "select 1 from public.consents where subject_id = $1 and source = 'erasure'", [l]));
    await asUser(owner.id, (q) => q("select public.audit_erase_request($1, 'leads', $2, true)", [org, l]));
    const first = await marks();
    expect(first).toBeGreaterThan(0);
    await asUser(owner.id, (q) => q("select public.audit_erase_request($1, 'leads', $2, true)", [org, l]));
    expect(await marks()).toBe(first);
  });

  it("asking again restarts a request whose completion stopped", async () => {
    const l = await lead(owner, "050-4440016");
    await asAdmin((q) => q("delete from public.leads where id = $1", [l]));
    await asAdmin((q) => q("insert into app.pending_erasures (organization_id, record_type, record_id, requested_by, attempts) values ($1, 'leads', $2, $3, 24)", [org, l, owner.id]));
    expect(await asUser(owner.id, async (q) => (await q<{ n: number }>("select public.audit_erase_record($1, 'leads', $2) as n", [org, l])).rows[0].n)).toBe(-1);
    expect(await asAdmin(async (q) => (await q("select attempts from app.pending_erasures where record_id = $1", [l])).rows)).toEqual([{ attempts: 0 }]);
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'consent_erasure_restarted' and organization_id = $1", [org]))).toBe(1);
    // and the next backfill completes it
    await asAdmin((q) => q("select app.consent_backfill_hashes()"));
    expect(await asAdmin((q) => count(q, "select 1 from app.pending_erasures where record_id = $1 and completed_at is not null", [l]))).toBe(1);
  });

  it("a probe with a phone on one's own record tells nothing about hidden, purged or erased records", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      // a lead the member cannot see opted out
      const hidden = await lead(admin, "050-7770001");
      await mark(admin, hidden, "withdrawn");
      const probe = await lead(member, "050-7770001");
      const e1 = await pgError(mark(member, probe, "granted"));
      expect(e1.hint).toBe("consent:address_blocked");
      // a person erased at their request
      const erased = await lead(admin, "050-7770002");
      await asAdmin((q) => q("delete from public.leads where id = $1", [erased]));
      await asUser(admin.id, (q) => q("select public.audit_erase_request($1, 'leads', $2, true)", [org, erased]));
      const probe2 = await lead(member, "050-7770002");
      const e2 = await pgError(mark(member, probe2, "granted"));
      expect(e2.hint).toBe("consent:address_blocked");
      // an admin still gets the specific answers
      const adminLead = await lead(admin, "050-7770001");
      expect((await pgError(mark(admin, adminLead, "granted"))).hint).toBe("consent:optout_locked");
      const adminLead2 = await lead(admin, "050-7770002");
      expect((await pgError(mark(admin, adminLead2, "granted"))).hint).toBe("consent:erasure_block");
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("someone outside the organization gets no state and no hash", async () => {
    const stranger = await createUser("cns4-outsider");
    await createOrg(stranger.id);
    const l = await lead(member, "050-7770003");
    await mark(member, l, "withdrawn");
    const hash = await asAdmin(async (q) => (await q<{ h: string }>("select address_hash as h from public.consents where lead_id = $1", [l])).rows[0].h);
    await asUser(stranger.id, async (q) => {
      expect((await q("select app.consent_state_of($1, 'sms', $2, null, null) as s", [org, hash])).rows[0].s).toBeNull();
      expect((await q("select app.consent_state_of($1, 'sms', null, $2, null) as s", [org, l])).rows[0].s).toBeNull();
      expect((await q("select app.consent_address_hash($1, 'phone', '+972507770003') as h", [org])).rows[0].h).toBeNull();
    });
    // a member gets them
    await asUser(member.id, async (q) => {
      expect((await q("select app.consent_state_of($1, 'sms', $2, null, null) as s", [org, hash])).rows[0].s).toBe("out");
    });
  });

  it("a restart at the person's request writes the do-not-contact marks", async () => {
    const l = await lead(owner, "050-7770004");
    await asAdmin((q) => q("delete from public.leads where id = $1", [l]));
    await asAdmin((q) =>
      q("insert into app.pending_erasures (organization_id, record_type, record_id, requested_by, attempts, person_request) values ($1, 'leads', $2, $3, 24, false)", [org, l, owner.id]),
    );
    await asUser(owner.id, (q) => q("select public.audit_erase_request($1, 'leads', $2, true)", [org, l]));
    expect(await asAdmin(async (q) => (await q("select person_request, attempts from app.pending_erasures where record_id = $1", [l])).rows)).toEqual([
      { person_request: true, attempts: 0 },
    ]);
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where subject_id = $1 and source = 'erasure'", [l]))).toBe(3);
    expect(await suppressed("050-7770004")).toBe(true);
  });

  it("an old opt-out under an earlier address does not unlock the specific answers", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const hidden = await lead(admin, "050-7770011");
      await mark(admin, hidden, "withdrawn");
      const erased = await lead(admin, "050-7770012");
      await asAdmin((q) => q("delete from public.leads where id = $1", [erased]));
      await asUser(admin.id, (q) => q("select public.audit_erase_request($1, 'leads', $2, true)", [org, erased]));
      for (const target of ["050-7770011", "050-7770012"]) {
        const probe = await lead(member, "050-7779999");
        await mark(member, probe, "withdrawn");
        await asUser(member.id, (q) => q("update public.leads set phone = $2 where id = $1", [probe, target]));
        expect((await pgError(mark(member, probe, "granted"))).hint, target).toBe("consent:address_blocked");
      }
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a request that becomes the person's own while it waits writes the marks, once", async () => {
    const l = await lead(owner, "050-7770013");
    await asAdmin((q) => q("update public.leads set email = 'wait@example.test' where id = $1", [l]));
    const marks = () => asAdmin((q) => count(q, "select 1 from public.consents where subject_id = $1 and source = 'erasure'", [l]));
    await setKey(null);
    try {
      // an entry still waiting for its hash: the erasure pauses
      await mark(owner, l, "granted");
      await asAdmin((q) => q("delete from public.leads where id = $1", [l]));
      expect(await asUser(owner.id, async (q) => (await q<{ n: number }>("select public.audit_erase_request($1, 'leads', $2, false) as n", [org, l])).rows[0].n)).toBe(-1);
      expect(await marks()).toBe(0);
      expect(await asUser(owner.id, async (q) => (await q<{ n: number }>("select public.audit_erase_request($1, 'leads', $2, true) as n", [org, l])).rows[0].n)).toBe(-1);
      expect(await asAdmin(async (q) => (await q("select person_request, attempts from app.pending_erasures where record_id = $1", [l])).rows)).toEqual([
        { person_request: true, attempts: 0 },
      ]);
      expect(await marks()).toBe(4);
      await asUser(owner.id, (q) => q("select public.audit_erase_request($1, 'leads', $2, true)", [org, l]));
      expect(await marks()).toBe(4);
    } finally {
      await setKey(KEY);
    }
    await asAdmin((q) => q("select app.consent_backfill_hashes()"));
    expect(await asAdmin((q) => count(q, "select 1 from app.pending_erasures where record_id = $1 and completed_at is not null", [l]))).toBe(1);
    expect(await suppressed("050-7770013")).toBe(true);
    expect(await asAdmin(async (q) => (await q("select app.consent_suppressed($1, 'email', 'wait@example.test') as s", [org])).rows[0].s)).toBe(true);
  });

  it("a two-step probe (own opt-out, then a consent) gets the same answer for opted out, erased and free", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const hidden = await lead(admin, "050-7770021");
      await mark(admin, hidden, "withdrawn");
      const erased = await lead(admin, "050-7770022");
      await asAdmin((q) => q("delete from public.leads where id = $1", [erased]));
      await asUser(admin.id, (q) => q("select public.audit_erase_request($1, 'leads', $2, true)", [org, erased]));
      for (const phone of ["050-7770021", "050-7770022", "050-7770023"]) {
        const probe = await lead(member, phone);
        await mark(member, probe, "withdrawn");
        expect((await pgError(mark(member, probe, "granted"))).hint, phone).toBe("consent:optout_locked");
      }
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("the person's request after a completed business erasure says that nothing is left to mark", async () => {
    const l = await lead(owner, "050-7770024");
    await asAdmin((q) => q("delete from public.leads where id = $1", [l]));
    await asUser(owner.id, (q) => q("select public.audit_erase_request($1, 'leads', $2, false)", [org, l]));
    const err = await pgError(asUser(owner.id, (q) => q("select public.audit_erase_request($1, 'leads', $2, true)", [org, l])));
    expect(err.hint).toBe("erase:no_address_left");
    expect(await asAdmin(async (q) => (await q("select person_request from app.pending_erasures where record_id = $1", [l])).rows)).toEqual([
      { person_request: false },
    ]);
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where subject_id = $1", [l]))).toBe(0);
    // the app shows a Hebrew explanation for it
    const { dbErrorMessage } = await import("@/lib/errors");
    expect(dbErrorMessage({ code: "P0001", hint: "erase:no_address_left", message: "x" })).toContain("לא לפנות");
  });
});
