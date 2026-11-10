import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { smsPreview } from "@/features/record-sms/logic";

import cases from "../unit/fixtures/sms-optout-replies.json";
import { asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const setKey = (value: string | null) =>
  asAdmin((q) =>
    value === null
      ? q("update app.settings set value = '' where key = 'consent_hash_key'")
      : q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]),
  );

afterAll(closePool);

const optout = (org: string, phone: string, body: string) =>
  asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.sms_inbound_optout($1, $2, $3) as r", [org, phone, body])).rows[0].r);
const suppressed = (org: string, phone: string) =>
  asService(async (q) => (await q<{ s: boolean | null }>("select app.consent_suppressed($1, 'sms', $2) as s", [org, phone])).rows[0].s);
const blocks = (org: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ kind: string; channel: string; reason: string; hashed: boolean; added_by: string | null }>(
          `select kind, channel, reason, address_hash is not null as hashed, added_by from public.consent_blocklist
            where organization_id = $1 and removed_at is null order by created_at, id`,
          [org],
        )
      ).rows,
  );
const rec = (records: number, blocklisted: boolean, further = 0) => ({ status: "recorded", records, further_phone_contacts: further, blocklisted });
const entries = (org: string, column: "lead_id" | "contact_id", id: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ channel: string; state: string; source: string; method: string; hashed: boolean }>(
          `select channel, state, source, method, address_hash is not null as hashed from public.consents
            where organization_id = $1 and ${column} = $2 order by seq`,
          [org, id],
        )
      ).rows,
  );

/**
 * SMS-03: the database side of an inbound "הסר" reply, for the future per-provider webhook (wave 3 use (2), not built). One
 * definer function granted to service_role only, that records an SMS opt-out of a phone in a business through the consent
 * path (HMAC hash), idempotent and rate-limited. No route calls it yet.
 */
describe("SMS opt-out by reply (SMS-03)", () => {
  let owner: { id: string }, ownerB: { id: string };
  let org: string, orgB: string;

  beforeAll(async () => {
    await setKey(KEY);
    owner = await createUser("sms-out-owner");
    org = await createOrg(owner.id, "עסק הסרה");
    ownerB = await createUser("sms-out-owner-b");
    orgB = await createOrg(ownerB.id, "עסק אחר");
  });
  afterAll(() => setKey(KEY));

  it("app.sms_optout_reply runs the shared fixture exactly as isSmsOptOutReply", async () => {
    const judge = (body: string) => asAdmin(async (q) => (await q<{ ok: boolean }>("select app.sms_optout_reply($1) as ok", [body])).rows[0].ok);
    for (const body of cases.optout) expect(await judge(body), JSON.stringify(body)).toBe(true);
    for (const body of cases.not) expect(await judge(body), JSON.stringify(body)).toBe(false);
  });

  it("records one 'withdrawn' SMS consent (source unsubscribe, hashed) on every record of the business with that phone", async () => {
    const lead = await insertLead(owner.id, org, { phone: "052-2220001" });
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone) values ($1, 'רון', '0522220001') returning id", [org])).rows[0].id,
    );
    const elsewhere = await insertLead(ownerB.id, orgB, { phone: "0522220001" });
    // a marketing grant first: the opt-out wins
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'בשיחה')", [org, lead]),
    );
    expect(await suppressed(org, "0522220001")).toBe(false);
    expect(await optout(org, "+972522220001", "הסר")).toEqual(rec(2, true));
    // (208) ב: the number joined the business's blocklist, sms channel, server reason, hash only
    expect(await blocks(org)).toEqual([{ kind: "phone", channel: "sms", reason: "sms_reply", hashed: true, added_by: null }]);
    expect(await blocks(orgB)).toEqual([]);
    expect(await suppressed(org, "0522220001")).toBe(true);
    const leadRows = await entries(org, "lead_id", lead);
    expect(leadRows.at(-1)).toEqual({ channel: "sms", state: "withdrawn", source: "unsubscribe", method: 'תשובת "הסר" ב-SMS', hashed: true });
    expect((await entries(org, "contact_id", contact)).map((r) => r.state)).toEqual(["withdrawn"]);
    // another business with the same number is untouched
    expect(await entries(orgB, "lead_id", elsewhere)).toEqual([]);
    expect(await suppressed(orgB, "0522220001")).toBe(false);
    // the same reply again (or another opt-out word) writes nothing
    expect(await optout(org, "0522220001", "STOP")).toEqual({ status: "already" });
    expect(await entries(org, "lead_id", lead)).toHaveLength(2);
    expect(await blocks(org)).toHaveLength(1);
    // a new record with the number later gets its own entry on the next reply; the old ones stay as they are
    const later = await insertLead(owner.id, org, { phone: "0522220001" });
    expect(await optout(org, "0522220001", "הסרה")).toEqual(rec(1, false));
    expect(await blocks(org)).toHaveLength(1);
    expect((await entries(org, "lead_id", later)).map((r) => r.state)).toEqual(["withdrawn"]);
  });

  it("ignores a reply that is not an opt-out, a bad number and an unknown business; stores nothing", async () => {
    const lead = await insertLead(owner.id, org, { phone: "0522220002" });
    const before = (await blocks(org)).length;
    expect(await optout(org, "0522220002", "תודה רבה")).toEqual({ status: "ignored" });
    expect(await optout(org, "0522220002", "אל תסירו אותי")).toEqual({ status: "ignored" });
    expect(await optout(org, "0522220002", "תפסיקו לשלוח לי")).toEqual({ status: "ignored" });
    expect(await optout(org, "not a phone", "הסר")).toEqual({ status: "invalid" });
    expect(await optout("11111111-1111-4111-8111-111111111111", "0522220002", "הסר")).toEqual({ status: "unknown_business" });
    expect(await optout(org, "0522220002", "")).toEqual({ status: "ignored" });
    expect(await entries(org, "lead_id", lead)).toEqual([]);
    expect(await blocks(org)).toHaveLength(before);
    // the reply's text is never stored anywhere
    const stored = await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.consents where method like '%תודה%'")).rows[0].n);
    expect(stored).toBe(0);
  });

  it("(208) ב: a number no record holds is blocklisted all the same, once; an active owner's block is not doubled", async () => {
    const before = (await blocks(org)).length;
    expect(await optout(org, "0522229999", "לא לשלוח")).toEqual(rec(0, true));
    expect(await optout(org, "0522229999", "STOP")).toEqual({ status: "already" });
    expect(await blocks(org)).toHaveLength(before + 1);
    expect(await suppressed(org, "0522229999")).toBe(true);
    // an owner's block on every channel already covers the number
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'all', array['0522229998'], 'person_request')", [org]));
    expect(await optout(org, "0522229998", "הסר")).toEqual({ status: "already" });
    expect(await blocks(org)).toHaveLength(before + 2);
    // a removed block does not count: a new reply blocks again
    const ids = await asAdmin(
      async (q) => (await q<{ id: string }>("select id from public.consent_blocklist where organization_id = $1 and reason = 'sms_reply' and removed_at is null", [org])).rows,
    );
    for (const { id } of ids) await asUser(owner.id, (q) => q("select public.consent_blocklist_remove($1, $2, 'added_by_mistake')", [org, id]));
    expect(await optout(org, "0522229999", "הסר")).toEqual(rec(0, true));
    // a person cannot pick the server's reason
    expect((await pgError(asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'sms', array['0522229997'], 'sms_reply')", [org])))).hint).toBe(
      "consent_blocklist:reason",
    );
  });

  it("F2: a contact with the number as a further phone is protected by the blocklist and counted, its primary phone untouched", async () => {
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone) values ($1, 'גל', '0522220010') returning id", [org])).rows[0].id,
    );
    await asUser(owner.id, (q) => q("insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'phone', '0522220011')", [org, contact]));
    expect(await optout(org, "0522220011", "הפסק")).toEqual(rec(0, true, 1));
    expect(await entries(org, "contact_id", contact)).toEqual([]);
    expect(await suppressed(org, "0522220011")).toBe(true);
    expect(await suppressed(org, "0522220010")).toBe(false);
  });

  it("a record in the recycle bin is marked too; a record already opted out is not marked again", async () => {
    const binned = await insertLead(owner.id, org, { phone: "0522220003" });
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [binned]));
    const out = await insertLead(owner.id, org, { phone: "0522220003" });
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'withdrawn', 'manual', 'ביקש')", [org, out]),
    );
    expect(await optout(org, "0522220003", "הסר")).toEqual(rec(1, true));
    expect((await entries(org, "lead_id", binned)).map((r) => r.source)).toEqual(["unsubscribe"]);
    expect((await entries(org, "lead_id", out)).map((r) => r.source)).toEqual(["manual"]);
  });

  it("without the hash key the opt-out is still recorded, unhashed and waiting, and the send check fails closed", async () => {
    const lead = await insertLead(owner.id, org, { phone: "0522220004" });
    await setKey(null);
    try {
      // F5: an opt-out the record holds for ANOTHER number does not stop the entry (no hash to match by)
      await asAdmin((q) => q("update public.leads set phone = '0522220014' where id = $1", [lead]));
      await asUser(owner.id, (q) =>
        q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'withdrawn', 'manual', 'ביקש')", [org, lead]),
      );
      await asAdmin((q) => q("update public.leads set phone = '0522220004' where id = $1", [lead]));
      expect(await optout(org, "0522220004", "הסר")).toEqual(rec(1, true));
      expect(await optout(org, "0522220004", "הסר")).toEqual({ status: "already" });
      expect((await entries(org, "lead_id", lead)).map((r) => [r.state, r.source, r.hashed])).toEqual([
        ["withdrawn", "manual", false],
        ["withdrawn", "unsubscribe", false],
      ]);
      // the blocklist entry waits too, unhashed
      const waiting = await asAdmin(
        async (q) =>
          (
            await q<{ n: number }>(
              "select count(*)::int as n from public.consent_blocklist b join app.consent_blocklist_pending p on p.entry_id = b.id where b.organization_id = $1 and b.address_hash is null and p.value = '+972522220004'",
              [org],
            )
          ).rows[0].n,
      );
      expect(waiting).toBe(1);
      const pending = await asAdmin(
        async (q) =>
          (
            await q<{ n: number }>(
              "select count(*)::int as n from app.consent_pending_address p join public.consents c on c.id = p.consent_id where c.lead_id = $1 and c.source = 'unsubscribe' and p.value is not null",
              [lead],
            )
          ).rows[0].n,
      );
      expect(pending).toBe(1);
      expect(await suppressed(org, "0522220004")).toBeNull();
    } finally {
      await setKey(KEY);
    }
    await asAdmin((q) => q("select app.consent_backfill_hashes()"));
    expect(await suppressed(org, "0522220004")).toBe(true);
  });

  it("is rate-limited per business and minute, and the count keeps no number", async () => {
    const lead = await insertLead(owner.id, org, { phone: "0522220005" });
    await asAdmin((q) =>
      q("insert into app.sms_optout_counts (organization_id, minute, n) values ($1, date_trunc('minute', now()), 600) on conflict (organization_id) do update set minute = excluded.minute, n = 600", [org]),
    );
    expect(await optout(org, "0522220005", "הסר")).toEqual({ status: "rate_limited" });
    // review (6): an ordinary reply is judged first and never counted
    expect(await optout(org, "0522220005", "תודה")).toEqual({ status: "ignored" });
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select n from app.sms_optout_counts where organization_id = $1", [org])).rows[0].n)).toBe(601);
    expect(await entries(org, "lead_id", lead)).toEqual([]);
    // another business has its own minute
    const leadB = await insertLead(ownerB.id, orgB, { phone: "0522220005" });
    expect(await optout(orgB, "0522220005", "הסר")).toEqual(rec(1, true));
    expect((await entries(orgB, "lead_id", leadB)).map((r) => r.state)).toEqual(["withdrawn"]);
    // the next minute starts again
    await asAdmin((q) => q("update app.sms_optout_counts set minute = minute - interval '1 minute' where organization_id = $1", [org]));
    expect(await optout(org, "0522220005", "הסר")).toEqual(rec(1, true));
    const columns = await asAdmin(
      async (q) =>
        (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'app' and table_name = 'sms_optout_counts' order by 1")).rows.map(
          (r) => r.c,
        ),
    );
    expect(columns).toEqual(["minute", "n", "organization_id"]);
  });

  it("is granted to service_role only; a person or a visitor cannot call it, nor read the counts", async () => {
    const rights = await asAdmin(
      async (q) =>
        (
          await q<{ role: string; call: boolean }>(
            `select r as role, has_function_privilege(r, 'public.sms_inbound_optout(uuid,text,text)', 'execute') as call
               from unnest(array['anon', 'authenticated', 'service_role']) r order by 1`,
          )
        ).rows,
    );
    expect(rights).toEqual([
      { role: "anon", call: false },
      { role: "authenticated", call: false },
      { role: "service_role", call: true },
    ]);
    expect((await pgError(asUser(owner.id, (q) => q("select public.sms_inbound_optout($1, '0522220001', 'הסר')", [org])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.sms_inbound_optout($1, '0522220001', 'הסר')", [org])))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select * from app.sms_optout_counts")))).code).toBe("42501");
  });
});

describe("SMS-03: the card's length check equals app.message_filled_problem on the enveloped SMS", () => {
  it("service at 300, marketing at 600 with what the system adds", async () => {
    const values = { firstName: "דנה", businessName: "מקסוז", businessPhone: "03-1234567", businessAddress: "הרצל 1" };
    for (const [type, length] of [
      ["requested_document", 300],
      ["requested_document", 301],
      ["marketing", 450],
      ["marketing", 560],
      ["marketing", 600],
    ] as const) {
      const preview = smsPreview({ messageType: type, body: "א".repeat(length) }, values);
      const sql = await asAdmin(
        async (q) => (await q<{ p: string | null }>("select app.message_filled_problem('sms', $1, null, $2) as p", [type, preview.body])).rows[0].p,
      );
      expect(sql === "too_long", `${type} ${length}`).toBe(preview.tooLong);
    }
  });
});
