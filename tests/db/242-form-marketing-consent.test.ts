import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

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
const hmac = (text: string) => createHmac("sha256", KEY).update(text, "utf8").digest("hex");

const VERSION = "form-draft-1";
const wording = (channel: "email" | "sms" | "whatsapp", business: string) =>
  `אני מאשר/ת לקבל עדכונים ופרסומות ${{ email: "באימייל", sms: "ב-SMS", whatsapp: "בוואטסאפ" }[channel]} מהעסק ${business}. אפשר לבטל את ההסכמה בכל עת.`;

const submit = (token: string, payload: Row, kind = "form") =>
  asService(async (q) =>
    (await q<{ r: Row }>("select public.intake_submit($1, $2, $3, null, null, false) as r", [token, kind, JSON.stringify(payload)])).rows[0].r,
  );
const formOf = (token: string) => asService(async (q) => (await q<{ r: Row }>("select public.intake_form($1) as r", [token])).rows[0].r);

/**
 * CAP-07 / CNS-04: the public web form may show an unticked marketing-consent box per channel it collects. A tick
 * becomes a form consent (source 'form', the server's DRAFT wording and its version) on the record the inquiry lands
 * on; an unticked box records nothing.
 */
describe("marketing-consent box on the public form (CAP-07, CNS-04)", () => {
  const BUSINESS = "סטודיו הסכמה";
  let owner: U, admin: U, member: U, viewer: U;
  let org: string;
  let form: { id: string; token: string };
  let webhook: { id: string; token: string };

  const consentsOf = (kind: "lead" | "contact", id: string) =>
    asAdmin(
      async (q) =>
        (
          await q<Row>(
            `select channel, state, source, wording, wording_version, address_hash, hash_version, recorded_by
               from public.consents where ${kind}_id = $1 order by seq`,
            [id],
          )
        ).rows,
    );
  const submissionOf = (lead: string | null, contact?: string) =>
    asAdmin(async (q) =>
      lead
        ? (await q<{ payload: Row }>("select payload from public.form_submissions where lead_id = $1 order by created_at desc limit 1", [lead])).rows[0]
            .payload
        : (
            await q<{ payload: Row }>(
              "select payload from public.form_submissions where organization_id = $1 and payload ->> 'phone' = $2 order by created_at desc limit 1",
              [org, contact],
            )
          ).rows[0].payload,
    );
  const setLeads = (on: boolean) =>
    asAdmin((q) =>
      q(
        "insert into public.org_modules (organization_id, leads_enabled) values ($1, $2) on conflict (organization_id) do update set leads_enabled = excluded.leads_enabled",
        [org, on],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("mc-owner");
    org = await createOrg(owner.id, BUSINESS);
    admin = await addMember(org, owner.id, "admin", "mc-admin");
    member = await addMember(org, owner.id, "member", "mc-member");
    viewer = await addMember(org, owner.id, "viewer", "mc-viewer");
    await asUser(owner.id, async (q) => {
      form = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, owner_id) values ($1, 'טופס דיוור', $2) returning id, token", [org, member.id]))
        .rows[0];
      webhook = (
        await q<{ id: string; token: string }>(
          "insert into public.forms (organization_id, kind, name, marketing_consent_channels) values ($1, 'webhook', 'Zapier', '{email,sms}') returning id, token",
          [org],
        )
      ).rows[0];
    });
  });

  it("owners and admins turn the boxes on; members and viewers cannot; only the three channels", async () => {
    expect(
      (await asUser(admin.id, (q) => q("update public.forms set marketing_consent_channels = '{email,sms,whatsapp}' where id = $1 returning id", [form.id]))).rowCount,
    ).toBe(1);
    for (const who of [member, viewer]) {
      expect((await asUser(who.id, (q) => q("update public.forms set marketing_consent_channels = '{}' where id = $1 returning id", [form.id]))).rowCount).toBe(0);
    }
    for (const bad of ["{phone}", "{fax}", "{email,NULL}"]) {
      const err = await pgError(asUser(owner.id, (q) => q("update public.forms set marketing_consent_channels = $2 where id = $1", [form.id, bad])));
      expect(err.code, bad).toBe("23514");
    }
  });

  it("intake_form shows one box per channel the form collects, with the business's DRAFT wording", async () => {
    const shown = (await formOf(form.token)).marketing_consent as { version: string; channels: Array<{ channel: string; text: string }> };
    expect(shown.version).toBe(VERSION);
    expect(shown.channels).toEqual([
      { channel: "email", text: wording("email", BUSINESS) },
      { channel: "sms", text: wording("sms", BUSINESS) },
      { channel: "whatsapp", text: wording("whatsapp", BUSINESS) },
    ]);
    // no phone field on the form: no SMS or WhatsApp box; no channel at all: no box
    const noPhone = await asUser(owner.id, async (q) =>
      (
        await q<{ token: string }>(
          `insert into public.forms (organization_id, name, fields, marketing_consent_channels)
           values ($1, 'בלי טלפון', '[{"key":"full_name","required":true},{"key":"email","required":true}]', '{sms,email,whatsapp}') returning token`,
          [org],
        )
      ).rows[0].token,
    );
    expect(((await formOf(noPhone)).marketing_consent as { channels: unknown[] }).channels).toEqual([{ channel: "email", text: wording("email", BUSINESS) }]);
    const off = await asUser(owner.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, name) values ($1, 'בלי תיבה') returning token", [org])).rows[0].token,
    );
    expect((await formOf(off)).marketing_consent).toBeNull();
  });

  it("a ticked box writes one granted form consent on the new lead, with the wording, version and hash", async () => {
    const r = await submit(form.token, { full_name: "דנה", phone: "050-7700001", email: "Dana@Example.Test", marketing_consent: ["email", "whatsapp"] });
    const lead = r.lead_id as string;
    const rows = await consentsOf("lead", lead);
    expect(rows).toEqual([
      {
        channel: "email",
        state: "granted",
        source: "form",
        wording: wording("email", BUSINESS),
        wording_version: VERSION,
        address_hash: hmac(`${org}:email:dana@example.test`),
        hash_version: 1,
        recorded_by: null,
      },
      {
        channel: "whatsapp",
        state: "granted",
        source: "form",
        wording: wording("whatsapp", BUSINESS),
        wording_version: VERSION,
        address_hash: hmac(`${org}:phone:+972507700001`),
        hash_version: 1,
        recorded_by: null,
      },
    ]);
    // the inquiry keeps the server's record of the ticked boxes
    expect((await submissionOf(lead)).marketing_consent).toEqual({
      version: VERSION,
      channels: ["email", "whatsapp"],
      wording: { email: wording("email", BUSINESS), whatsapp: wording("whatsapp", BUSINESS) },
    });
    // a member who reads the lead sees the version; nobody may change it
    const seen = await asUser(owner.id, async (q) => (await q<{ v: string }>("select wording_version as v from public.consents where lead_id = $1 limit 1", [lead])).rows[0].v);
    expect(seen).toBe(VERSION);
    const changed = await pgError(asAdmin((q) => q("update public.consents set wording_version = 'other' where lead_id = $1", [lead])));
    expect(changed.hint).toBe("consent:append_only");
  });

  it("an unticked box records nothing, and the sender's own wording never counts", async () => {
    const plain = await submit(form.token, { full_name: "בלי סימון", phone: "050-7700002", email: "none@example.test" });
    expect(await consentsOf("lead", plain.lead_id as string)).toEqual([]);
    expect((await submissionOf(plain.lead_id as string)).marketing_consent).toBeUndefined();
    const empty = await submit(form.token, { full_name: "ריק", phone: "050-7700003", marketing_consent: [] });
    expect(await consentsOf("lead", empty.lead_id as string)).toEqual([]);
    // forged: a channel the form does not show, junk, and an object with its own wording
    const forged = await submit(form.token, { full_name: "מזויף", phone: "050-7700004", marketing_consent: { email: "כל מה שאני רוצה" } });
    expect(await consentsOf("lead", forged.lead_id as string)).toEqual([]);
    expect((await submissionOf(forged.lead_id as string)).marketing_consent).toBeUndefined();
  });

  it("a tick needs the address it is for, and a channel the form shows", async () => {
    // email ticked, no email given; SMS ticked as a single value
    const r = await submit(form.token, { full_name: "רק טלפון", phone: "050-7700005", marketing_consent: ["email", "sms", "phone", "fax"] });
    expect((await consentsOf("lead", r.lead_id as string)).map((row) => row.channel)).toEqual(["sms"]);
    const single = await submit(form.token, { full_name: "ערך יחיד", phone: "050-7700006", marketing_consent: "whatsapp" });
    expect((await consentsOf("lead", single.lead_id as string)).map((row) => row.channel)).toEqual(["whatsapp"]);
    // the box switched off: a tick is ignored
    await asUser(owner.id, (q) => q("update public.forms set marketing_consent_channels = '{email}' where id = $1", [form.id]));
    const off = await submit(form.token, { full_name: "כבוי", phone: "050-7700007", marketing_consent: ["sms"] });
    expect(await consentsOf("lead", off.lead_id as string)).toEqual([]);
    await asUser(owner.id, (q) => q("update public.forms set marketing_consent_channels = '{email,sms,whatsapp}' where id = $1", [form.id]));
    // a webhook has no box
    const hook = await submit(webhook.token, { full_name: "וובהוק", phone: "050-7700008", email: "hook@example.test", marketing_consent: ["email", "sms"] }, "webhook");
    expect(await consentsOf("lead", hook.lead_id as string)).toEqual([]);
  });

  it("a repeat inquiry records on the matched lead and its contact, only for the address typed", async () => {
    const first = await submit(form.token, { full_name: "חוזרת", phone: "050-7700010", email: "old@example.test" });
    const lead = first.lead_id as string;
    // matched by phone; the new email is not the lead's, so only SMS is recorded
    const again = await submit(form.token, { full_name: "חוזרת", phone: "050-7700010", email: "new@example.test", marketing_consent: ["email", "sms"] });
    expect(again.status).toBe("duplicate");
    expect((await consentsOf("lead", lead)).map((row) => [row.channel, row.source])).toEqual([["sms", "form"]]);
    // the inquiry still keeps both ticks and their wording
    const stored = await asAdmin(
      async (q) =>
        (await q<{ payload: Row }>("select payload from public.form_submissions where lead_id = $1 and status = 'duplicate' order by created_at desc limit 1", [lead]))
          .rows[0].payload,
    );
    expect((stored.marketing_consent as Row).channels).toEqual(["email", "sms"]);

    // a matched contact
    const contact = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone, email) values ($1, 'איש', '050-7700011', 'c@example.test') returning id", [org]))
        .rows[0].id,
    );
    const toContact = await submit(form.token, { full_name: "איש", phone: "050-7700011", email: "C@Example.test", marketing_consent: ["email", "whatsapp"] });
    expect(toContact.contact_id).toBe(contact);
    expect((await consentsOf("contact", contact)).map((row) => row.channel)).toEqual(["email", "whatsapp"]);

    // a converted lead: both the lead and its contact
    const converted = await insertLead(member.id, org, { full_name: "הומר", phone: "050-7700012" });
    const made = await asUser(member.id, async (q) => (await q<{ r: Row }>("select public.convert_lead($1, false) as r", [converted])).rows[0].r);
    const madeContact = made.contact_id as string;
    await submit(form.token, { full_name: "הומר", phone: "050-7700012", marketing_consent: ["sms"] });
    expect((await consentsOf("lead", converted)).map((row) => row.channel)).toEqual(["sms"]);
    expect((await consentsOf("contact", madeContact)).filter((row) => row.source === "form").map((row) => row.channel)).toEqual(["sms"]);
  });

  it("a public-form tick does not lift an opt-out or an erasure block (it waits for a double opt-in); an address with no history still records", async () => {
    const lead = await insertLead(member.id, org, { full_name: "הסירה", phone: "050-7700020" });
    await asUser(member.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'withdrawn', 'manual', 'ביקשה בטלפון')", [org, lead]),
    );
    const suppressed = (channel: string, value: string) =>
      asAdmin(async (q) => (await q<{ s: boolean | null }>("select app.consent_suppressed($1, $2, $3) as s", [org, channel, value])).rows[0].s);
    expect(await suppressed("sms", "050-7700020")).toBe(true);
    // anyone who knows the number ticks SMS and WhatsApp: the opted-out SMS stays out (the tick waits for a double opt-in,
    // owner's answer 3), WhatsApp (no history) is recorded
    await submit(form.token, { full_name: "מישהו", phone: "050-7700020", marketing_consent: ["sms", "whatsapp"] });
    expect(await suppressed("sms", "050-7700020")).toBe(true);
    expect((await consentsOf("lead", lead)).map((row) => [row.channel, row.state, row.source])).toEqual([
      ["sms", "withdrawn", "manual"],
      ["sms", "awaiting_confirmation", "form"],
      ["whatsapp", "granted", "form"],
    ]);
    // the tick stays on the inquiry record
    const stored = await asAdmin(
      async (q) =>
        (await q<{ payload: Row }>("select payload from public.form_submissions where lead_id = $1 order by created_at desc limit 1", [lead])).rows[0].payload,
    );
    expect((stored.marketing_consent as Row).channels).toEqual(["sms", "whatsapp"]);

    // an erasure block of an address, on a record no longer matched: a new lead with that email gets no email consent
    const erased = await insertLead(member.id, org, { full_name: "נמחקה", phone: "050-7700021", email: "erased@example.test" });
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'email', 'withdrawn', 'erasure')", [org, erased]));
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [erased]));
    const fresh = await submit(form.token, { full_name: "חדשה", phone: "050-7700022", email: "Erased@Example.test", marketing_consent: ["email", "sms"] });
    expect(fresh.status).toBe("accepted");
    expect((await consentsOf("lead", fresh.lead_id as string)).map((row) => [row.channel, row.state])).toEqual([
      ["email", "awaiting_confirmation"],
      ["sms", "granted"],
    ]);
    expect(await suppressed("email", "erased@example.test")).toBe(true);
  });

  it("a spam submission keeps no consent record, whatever the sender put there", async () => {
    await asService((q) =>
      q("select public.intake_submit($1, 'form', $2, null, null, true)", [
        form.token,
        JSON.stringify({ full_name: "בוט", phone: "050-7700090", marketing_consent: { version: "forged", channels: ["email"], wording: { email: "x" } } }),
      ]),
    );
    const payload = await asAdmin(
      async (q) =>
        (
          await q<{ payload: Row }>(
            "select payload from public.form_submissions where form_id = $1 and status = 'spam' order by created_at desc limit 1",
            [form.id],
          )
        ).rows[0].payload,
    );
    expect(payload).toEqual({ full_name: "בוט", phone: "050-7700090" });
    // the trim drops it from any spam row too
    const direct = await asAdmin(
      async (q) =>
        (
          await q<{ payload: Row }>(
            "insert into public.form_submissions (organization_id, form_id, status, payload) values ($1, $2, 'spam', $3) returning payload",
            [org, form.id, JSON.stringify({ phone: "050-7700091", marketing_consent: { version: "v", channels: ["sms"], wording: { sms: "y" } } })],
          )
        ).rows[0].payload,
    );
    expect(direct).toEqual({ phone: "050-7700091" });
  });

  it("with leads off the consent goes on the new contact", async () => {
    await setLeads(false);
    try {
      const r = await submit(form.token, { full_name: "בלי לידים", phone: "050-7700030", email: "nl@example.test", marketing_consent: ["email", "sms"] });
      expect(r.status).toBe("accepted");
      const contact = r.contact_id as string;
      const rows = await consentsOf("contact", contact);
      expect(rows.map((row) => [row.channel, row.source, row.wording_version])).toEqual([
        ["email", "form", VERSION],
        ["sms", "form", VERSION],
      ]);
      expect((await submissionOf(null, "050-7700030")).marketing_consent).toMatchObject({ channels: ["email", "sms"] });
    } finally {
      await setLeads(true);
    }
  });

  it("without the hash key the consent waits with its address, and the backfill hashes it", async () => {
    await setKey(null);
    let lead: string;
    try {
      // SMS: the business has a hashed SMS opt-out that cannot be compared without the key, so nothing is lifted (fail
      // closed: the tick waits for a double opt-in); WhatsApp has none, so the tick is recorded; both wait for their hash
      const r = await submit(form.token, { full_name: "בלי מפתח", phone: "050-7700040", marketing_consent: ["whatsapp", "sms"] });
      lead = r.lead_id as string;
      const rows = await consentsOf("lead", lead);
      expect(
        rows.map((row) => [row.channel, row.state, row.source, row.address_hash, row.hash_version, row.wording_version]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual([
        ["sms", "awaiting_confirmation", "form", null, 1, VERSION],
        ["whatsapp", "granted", "form", null, 1, VERSION],
      ]);
      const pending = await asAdmin(
        async (q) =>
          (
            await q<{ value: string | null }>(
              "select p.value from app.consent_pending_address p join public.consents c on c.id = p.consent_id where c.lead_id = $1",
              [lead],
            )
          ).rows,
      );
      expect(pending).toEqual([{ value: "+972507700040" }, { value: "+972507700040" }]);
    } finally {
      await setKey(KEY);
    }
    await asAdmin((q) => q("select app.consent_backfill_hashes()"));
    expect((await consentsOf("lead", lead)).map((row) => row.address_hash)).toEqual([hmac(`${org}:phone:+972507700040`), hmac(`${org}:phone:+972507700040`)]);
  });

  it("the conversion copy keeps the wording and its version; a person's entry has none", async () => {
    const r = await submit(form.token, { full_name: "להמרה", phone: "050-7700050", marketing_consent: ["sms"] });
    const lead = r.lead_id as string;
    const made = await asUser(member.id, async (q) => (await q<{ r: Row }>("select public.convert_lead($1, false) as r", [lead])).rows[0].r);
    const copied = await consentsOf("contact", made.contact_id as string);
    expect(copied.map((row) => [row.channel, row.source, row.wording, row.wording_version])).toEqual([["sms", "form", wording("sms", BUSINESS), VERSION]]);
    // a person cannot write a version
    const manual = await insertLead(member.id, org, { full_name: "ידני", phone: "050-7700051" });
    const forged = await pgError(
      asUser(member.id, (q) =>
        q(
          "insert into public.consents (organization_id, lead_id, channel, state, source, method, wording_version) values ($1, $2, 'sms', 'granted', 'manual', 'בעל פה', 'x')",
          [org, manual],
        ),
      ),
    );
    expect(forged.code).toBe("42501");
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where lead_id = $1", [manual]))).toBe(0);
  });

  it("a tick on a locked address is kept as awaiting a double opt-in: the form, the wording and the hash, and it lifts nothing", async () => {
    // owner's answer 3 (26 October 2026): the opted-out address stays out; the tick is a marker the double opt-in will confirm
    const lead = await insertLead(member.id, org, { full_name: "ממתינה", phone: "050-7700060", email: "wait@example.test" });
    await asUser(member.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'withdrawn', 'manual', 'ביקשה במייל')", [org, lead]),
    );
    const again = await submit(form.token, { full_name: "ממתינה", phone: "050-7700060", email: "WAIT@example.test", marketing_consent: ["email"] });
    expect(again.status).toBe("duplicate");
    const rows = await asAdmin(
      async (q) =>
        (
          await q<Row>(
            `select channel, state, source, method, wording, wording_version, address_hash, recorded_by
               from public.consents where lead_id = $1 and state = 'awaiting_confirmation'`,
            [lead],
          )
        ).rows,
    );
    expect(rows).toEqual([
      {
        channel: "email",
        state: "awaiting_confirmation",
        source: "form",
        method: "טופס: טופס דיוור",
        wording: wording("email", BUSINESS),
        wording_version: VERSION,
        address_hash: hmac(`${org}:email:wait@example.test`),
        recorded_by: null,
      },
    ]);
    // the same tick again the same day writes nothing new
    await submit(form.token, { full_name: "ממתינה", phone: "050-7700060", email: "wait@example.test", marketing_consent: ["email"] });
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where lead_id = $1 and state = 'awaiting_confirmation'", [lead]))).toBe(1);
    // nothing is lifted: the address is still suppressed, the state of the record is still "withdrawn"
    const suppressedEmail = await asAdmin(
      async (q) => (await q<{ s: boolean }>("select app.consent_suppressed($1, 'email', 'wait@example.test') as s", [org])).rows[0].s,
    );
    expect(suppressedEmail).toBe(true);
    const current = await asUser(member.id, async (q) => (await q<Row>("select channel, state from public.consent_current($1, 'lead', $2)", [org, lead])).rows);
    expect(current).toEqual([{ channel: "email", state: "withdrawn" }]);
    // only the server writes it: a person cannot, not even an owner
    const forged = await pgError(
      asUser(owner.id, (q) =>
        q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'awaiting_confirmation', 'manual', 'x')", [
          org,
          lead,
        ]),
      ),
    );
    expect(forged.code).toBe("23514");
    expect((await pgError(asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'sms', 'awaiting_confirmation', 'import')", [org, lead])))).code).toBe("23514");
    // append-only like every entry
    expect((await pgError(asAdmin((q) => q("update public.consents set state = 'granted' where lead_id = $1 and state = 'awaiting_confirmation'", [lead])))).hint).toBe(
      "consent:append_only",
    );
    // the conversion carries the real state and the marker after it
    const made = await asUser(member.id, async (q) => (await q<{ r: Row }>("select public.convert_lead($1, false) as r", [lead])).rows[0].r);
    expect((await consentsOf("contact", made.contact_id as string)).map((row) => [row.channel, row.state])).toEqual([
      ["email", "withdrawn"],
      ["email", "awaiting_confirmation"],
    ]);
    // a later real state is the state; an older marker is history only
    await asUser(member.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'denied', 'manual', 'שוב לא')", [org, lead]),
    );
    const lead2 = await asUser(member.id, async (q) => (await q<Row>("select channel, state from public.consent_current($1, 'lead', $2)", [org, lead])).rows);
    expect(lead2).toEqual([{ channel: "email", state: "denied" }]);
  });
});
