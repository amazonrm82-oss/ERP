import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PREFERENCES_CONSENT_VERSION, PREFERENCES_CONSENT_WORDING } from "@/features/preferences/model";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const setKey = (value: string | null) =>
  asAdmin((q) =>
    value === null
      ? q("update app.settings set value = '' where key = 'consent_hash_key'")
      : q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]),
  );

afterAll(closePool);

type Page = {
  business: string;
  brand: { logo: string | null; color: string | null };
  built_with: boolean;
  channel: string;
  full: boolean;
  unsubscribe_only: boolean;
  channels: { channel: string; state: string; can_turn_on: boolean }[];
};

const mint = (user: string, org: string, kind: "lead" | "contact", id: string, channel: string) =>
  asUser(user, async (q) => (await q<{ t: string }>("select public.consent_preference_link_create($1, $2, $3, $4) as t", [org, kind, id, channel])).rows[0].t);
// the link a message carries (the future sender's mint, a marketing job's live lease); a staff copy turns on only for 7 days (250)
const sent = async (org: string, kind: "lead" | "contact", id: string, channel: string) => {
  const job = await asAdmin(
    async (q) =>
      (
        await q<{ id: string; lease_id: string }>(
          `insert into app.jobs (organization_id, kind, payload, status, lease_id, locked_until)
           values ($1, 'message.send', $2, 'running', gen_random_uuid(), now() + interval '1 minute') returning id, lease_id`,
          [org, JSON.stringify({ channel, [`${kind}_id`]: id, message_type: "marketing" })],
        )
      ).rows[0],
  );
  try {
    const answer = await asService(
      async (q) => (await q<{ r: { token?: string; refused?: string } }>("select public.consent_preference_link_for_job($1, $2) as r", [job.id, job.lease_id])).rows[0].r,
    );
    if (!answer.token) throw new Error(`no link: ${answer.refused}`);
    return answer.token;
  } finally {
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where id = $1", [job.id]));
  }
};
const read = (token: string, ip: string | null = null) =>
  asService(async (q) => (await q<{ r: Page & { rate_limited?: boolean } }>("select public.consent_preferences_public($1, $2) as r", [token, ip])).rows[0].r);
const submit = (token: string, mode: string, choices: unknown = null, ip: string | null = null) =>
  asService(
    async (q) =>
      (await q<{ r: Record<string, unknown> }>("select public.consent_preferences_submit($1, $2, $3, $4) as r", [token, mode, choices === null ? null : JSON.stringify(choices), ip])).rows[0].r,
  );
const suppressed = (org: string, channel: string, address: string) =>
  asService(async (q) => (await q<{ s: boolean | null }>("select app.consent_suppressed($1, $2, $3) as s", [org, channel, address])).rows[0].s);
const entries = (org: string, column: "lead_id" | "contact_id", id: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ channel: string; state: string; source: string; method: string | null; wording: string | null; wording_version: string | null }>(
          `select channel, state, source, method, wording, wording_version from public.consents where organization_id = $1 and ${column} = $2 order by seq`,
          [org, id],
        )
      ).rows,
  );
const blocks = (org: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ kind: string; channel: string; reason: string; added_by: string | null }>(
          "select kind, channel, reason, added_by from public.consent_blocklist where organization_id = $1 and removed_at is null order by created_at, id",
          [org],
        )
      ).rows,
  );
const serviceBlocked = (org: string, channel: string, address: string) =>
  asAdmin(async (q) => (await q<{ s: boolean | null }>("select app.consent_service_blocked($1, $2, $3) as s", [org, channel, address])).rows[0].s);
const relistOk = (org: string, channel: string, address: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ ok: boolean }>(
          "select app.consent_preference_relist_ok($1, $2, app.consent_address_hash($1, app.consent_address_kind($2), $3, 1::smallint)) as ok",
          [org, channel, channel === "email" ? address : `+972${address.slice(1)}`],
        )
      ).rows[0].ok,
  );
const channelState = (page: Page, channel: string) => page.channels.find((c) => c.channel === channel);

/**
 * CNS-09 / CNS-10 (owner's answer (225) א): the customer's unsubscribe link and preferences page. One definer for reading and
 * one for writing, service_role only; the link kept as SHA-256; one per record and channel; the answer holds the channels and
 * the choice only; every change is an ordinary consent entry; an unsubscribe always joins the blocklist (208); a lock is never
 * lifted from the page.
 */
describe("consent preferences link (CNS-09, CNS-10)", () => {
  let owner: { id: string }, member: { id: string }, ownerB: { id: string };
  let org: string, orgB: string;

  beforeAll(async () => {
    await setKey(KEY);
    owner = await createUser("prefs-owner");
    org = await createOrg(owner.id, "עסק העדפות");
    member = await addMember(org, owner.id, "member", "prefs-member");
    ownerB = await createUser("prefs-owner-b");
    orgB = await createOrg(ownerB.id, "עסק אחר");
  });
  afterAll(() => setKey(KEY));

  it("only service_role reaches the public functions; staff mint is for owners and admins of the business", async () => {
    for (const fn of ["consent_preferences_public(text,text)", "consent_preferences_submit(text,text,jsonb,text)", "consent_preference_link_for_job(uuid,uuid)"]) {
      const rights = await asAdmin(
        async (q) =>
          (
            await q<{ anon: boolean; auth: boolean; service: boolean }>(
              `select has_function_privilege('anon', 'public.${fn}', 'execute') as anon,
                      has_function_privilege('authenticated', 'public.${fn}', 'execute') as auth,
                      has_function_privilege('service_role', 'public.${fn}', 'execute') as service`,
            )
          ).rows[0],
      );
      expect(rights, fn).toEqual({ anon: false, auth: false, service: true });
    }
    const lead = await insertLead(owner.id, org, { email: "dana@example.test", phone: "0523330001" });
    expect((await pgError(mint(member.id, org, "lead", lead, "email"))).code).toBe("42501");
    expect((await pgError(mint(ownerB.id, org, "lead", lead, "email"))).code).toBe("42501");
    // another business's owner naming a record of this business through their own business
    expect((await pgError(mint(ownerB.id, orgB, "lead", lead, "email"))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.consent_preference_link_create($1, 'lead', $2, 'email')", [org, lead]))))).toMatchObject({
      code: "42501",
    });
    const noPhone = await insertLead(owner.id, org, { email: "only@example.test" });
    expect((await pgError(mint(owner.id, org, "lead", noPhone, "sms"))).hint).toBe("consent_link:no_address");
    // the link is kept as its hash only; the audit entry names the channel, never the token
    const token = await mint(owner.id, org, "lead", lead, "email");
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const stored = await asAdmin(
      async (q) => (await q<{ n: number }>("select count(*)::int as n from app.consent_preference_tokens where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [token])).rows[0].n,
    );
    expect(stored).toBe(1);
    const audit = await asAdmin(
      async (q) => (await q<{ changes: Record<string, unknown> }>("select changes from public.audit_log where organization_id = $1 and action = 'consent_link' and entity_id = $2", [org, lead])).rows,
    );
    expect(audit.map((a) => a.changes)).toEqual([{ channel: "email", link: "created" }]);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("no key = no link", async () => {
    const lead = await insertLead(owner.id, org, { email: "nokey@example.test" });
    await setKey(null);
    try {
      expect((await pgError(mint(owner.id, org, "lead", lead, "email"))).hint).toBe("consent_link:no_key");
    } finally {
      await setKey(KEY);
    }
  });

  it("the page answers the business's display fields and the channels only: no name, phone, email or id", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "שרה כהן", email: "sara@example.test", phone: "052-3330002" });
    const token = await mint(owner.id, org, "lead", lead, "email");
    const page = await read(token);
    expect(Object.keys(page).sort()).toEqual(["brand", "built_with", "business", "channel", "channels", "full", "unsubscribe_only"]);
    expect(page.business).toBe("עסק העדפות");
    expect(page.channel).toBe("email");
    expect(page.full).toBe(true);
    // review 1: only the link's own channel; the page never tells which other channels hold an address
    expect(page.channels.map((c) => c.channel)).toEqual(["email"]);
    for (const c of page.channels) expect(Object.keys(c).sort()).toEqual(["can_turn_on", "channel", "state"]);
    const text = JSON.stringify(page);
    for (const secret of ["שרה", "sara@", "3330002", lead, org]) expect(text).not.toContain(secret);
    // one not-found rule: a bad shape, an unknown token
    for (const bad of ["short", "x".repeat(64), `${token.slice(0, 63)}A`]) {
      if (bad === token) continue;
      expect((await pgError(read(bad))).code).toBe("P0002");
      expect((await pgError(submit(bad, "unsubscribe"))).code).toBe("P0002");
    }
  });

  it("the link a message carries never gives a first consent; unsubscribing records the opt-out and the blocklist; it re-subscribes the person's own unsubscribe", async () => {
    const lead = await insertLead(owner.id, org, { email: "roni@example.test", phone: "0523330003" });
    const token = await sent(org, "lead", lead, "email");
    // owner (254) ב: a message link only unsubscribes and re-subscribes: a channel never consented is not turned on
    expect(channelState(await read(token), "email")).toEqual({ channel: "email", state: "unknown", can_turn_on: false });
    // review 1: an email link never turns SMS or WhatsApp marketing on for the record's phone
    expect(await submit(token, "preferences", [{ channel: "whatsapp", on: true }, { channel: "sms", on: true }, { channel: "email", on: true }])).toEqual({
      status: "saved",
      results: [
        { channel: "whatsapp", result: "refused" },
        { channel: "sms", result: "refused" },
        { channel: "email", result: "refused" },
      ],
    });
    expect(await entries(org, "lead_id", lead)).toEqual([]);
    expect(await suppressed(org, "email", "roni@example.test")).toBe(false);
    // the one-click unsubscribe of the email link
    const before = (await blocks(org)).length;
    expect(await submit(token, "unsubscribe")).toEqual({ status: "done" });
    expect((await entries(org, "lead_id", lead)).at(-1)).toMatchObject({ channel: "email", state: "withdrawn", source: "unsubscribe", method: "קישור הסרה" });
    expect((await blocks(org)).slice(before)).toEqual([{ kind: "email", channel: "email", reason: "unsubscribe_link", added_by: null }]);
    expect(await suppressed(org, "email", "roni@example.test")).toBe(true);
    // (230) ב: an unsubscribe-link entry stops marketing only; service messages keep going
    expect(await serviceBlocked(org, "email", "roni@example.test")).toBe(false);
    // twice = nothing new
    expect(await submit(token, "unsubscribe")).toEqual({ status: "done" });
    expect(await entries(org, "lead_id", lead)).toHaveLength(1);
    expect((await blocks(org)).length).toBe(before + 1);
    // (231) ב: the person's own unsubscribe is lifted from the page: the link's entry is marked removed, a grant is written
    expect(channelState(await read(token), "email")).toEqual({ channel: "email", state: "out", can_turn_on: true });
    expect(await submit(token, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "saved" }] });
    expect((await entries(org, "lead_id", lead)).at(-1)).toEqual({
      channel: "email",
      state: "granted",
      source: "preferences",
      method: "דף העדפות",
      wording: PREFERENCES_CONSENT_WORDING,
      wording_version: PREFERENCES_CONSENT_VERSION,
    });
    expect((await blocks(org)).length).toBe(before);
    const removed = await asAdmin(
      async (q) =>
        (await q<{ removed_reason: string }>("select removed_reason from public.consent_blocklist where organization_id = $1 and reason = 'unsubscribe_link' and removed_at is not null", [org])).rows,
    );
    expect(removed.map((r) => r.removed_reason)).toContain("resubscribed");
    expect(await suppressed(org, "email", "roni@example.test")).toBe(false);
    // "remove me from every channel": the link's channel and the record's phone channels, all off
    expect(await submit(token, "unsubscribe_all")).toEqual({ status: "done" });
    expect(await suppressed(org, "email", "roni@example.test")).toBe(true);
    expect(await suppressed(org, "sms", "0523330003")).toBe(true);
    expect(await suppressed(org, "whatsapp", "0523330003")).toBe(true);
  });

  it("only the person's own unsubscribe is lifted: never a manual opt-out or a manual blocklist entry", async () => {
    // a manual opt-out of the address before the link's unsubscribe
    const lead = await insertLead(owner.id, org, { email: "manual@example.test" });
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'withdrawn', 'manual', 'בשיחה')", [org, lead]),
    );
    const token = await sent(org, "lead", lead, "email");
    await submit(token, "unsubscribe");
    expect(channelState(await read(token), "email")).toEqual({ channel: "email", state: "out", can_turn_on: false });
    expect(await submit(token, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    // the record was already out: the link adds only its blocklist entry, and nothing is granted
    expect((await entries(org, "lead_id", lead)).map((e) => e.state)).toEqual(["withdrawn"]);
    expect(await suppressed(org, "email", "manual@example.test")).toBe(true);

    // an owner's blocklist entry beside the link's own: refused, and service messages stay stopped by the owner's entry
    const listed = await insertLead(owner.id, org, { email: "listed@example.test" });
    const listedToken = await sent(org, "lead", listed, "email");
    await submit(listedToken, "unsubscribe");
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'all', array['listed@example.test'], 'person_request')", [org]));
    expect(await submit(listedToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect(await serviceBlocked(org, "email", "listed@example.test")).toBe(true);
  });

  it("delta review 1: after a link unsubscribe, an owner's entry and an SMS reply are each stored, stop service messages and block the re-subscribe", async () => {
    // the owner adds the same address with a stronger reason
    const lead = await insertLead(owner.id, org, { email: "strong@example.test", phone: "0523330010" });
    const token = await sent(org, "lead", lead, "email");
    await submit(token, "unsubscribe");
    expect(await serviceBlocked(org, "email", "strong@example.test")).toBe(false);
    const added = await asUser(owner.id, async (q) =>
      (await q<{ r: { added: number; existing: number } }>("select public.consent_blocklist_add($1, 'email', array['strong@example.test'], 'complaint') as r", [org])).rows[0].r,
    );
    expect(added).toMatchObject({ added: 1, existing: 0 });
    expect(await serviceBlocked(org, "email", "strong@example.test")).toBe(true);
    expect(await relistOk(org, "email", "strong@example.test")).toBe(false);
    expect(channelState(await read(token), "email")).toEqual({ channel: "email", state: "out", can_turn_on: false });
    expect(await submit(token, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    // the link's entry was superseded, not lost: when the owner removes his entry, the person's own unsubscribe comes back
    const ownerEntry = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("select id from public.consent_blocklist where organization_id = $1 and reason = 'complaint' and removed_at is null", [org])).rows[0].id,
    );
    await asUser(owner.id, (q) => q("select public.consent_blocklist_remove($1, $2, 'added_by_mistake')", [org, ownerEntry]));
    expect(await suppressed(org, "email", "strong@example.test")).toBe(true);
    expect(await serviceBlocked(org, "email", "strong@example.test")).toBe(false);
    expect(await relistOk(org, "email", "strong@example.test")).toBe(true);
    // an SMS "הסר" reply after a link unsubscribe stores its own entry (rule 209 ב)
    const smsToken = await sent(org, "lead", lead, "sms");
    await submit(smsToken, "unsubscribe");
    expect(await serviceBlocked(org, "sms", "0523330010")).toBe(false);
    const reply = await asService(
      async (q) => (await q<{ r: Record<string, unknown> }>("select public.sms_inbound_optout($1, '0523330010', 'הסר') as r", [org])).rows[0].r,
    );
    expect(reply).toMatchObject({ status: "recorded", blocklisted: true });
    expect(await serviceBlocked(org, "sms", "0523330010")).toBe(true);
    expect(await relistOk(org, "sms", "0523330010")).toBe(false);
    expect(await submit(smsToken, "preferences", [{ channel: "sms", on: true }])).toEqual({ status: "saved", results: [{ channel: "sms", result: "refused" }] });
  });

  it("delta review 2-1: an unsubscribe for an address the owner listed first is kept, on 'all' and on the same channel", async () => {
    const entryId = (address: string, reason: string) =>
      asAdmin(
        async (q) =>
          (
            await q<{ id: string }>(
              `select b.id from public.consent_blocklist b
                where b.organization_id = $1 and b.reason = $3 and b.removed_at is null
                  and b.address_hash = app.consent_address_hash($1, 'email', $2, 1::smallint)`,
              [org, address, reason],
            )
          ).rows[0]?.id,
      );
    for (const channel of ["all", "email"]) {
      const address = `listed-first-${channel}@example.test`;
      const lead = await insertLead(owner.id, org, { email: address });
      const token = await sent(org, "lead", lead, "email");
      // the record moves on to another address; the owner lists the old one
      await asUser(owner.id, (q) => q("update public.leads set email = $2 where id = $1", [lead, `moved-${channel}@example.test`]));
      await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, $2, array[$3], 'complaint')", [org, channel, address]));
      expect(await submit(token, "unsubscribe")).toEqual({ status: "done" });
      // the owner removes his entry later: the person's own unsubscribe still holds
      const id = await entryId(address, "complaint");
      expect(id).toBeDefined();
      await asUser(owner.id, (q) => q("select public.consent_blocklist_remove($1, $2, 'added_by_mistake')", [org, id]));
      expect(await suppressed(org, "email", address)).toBe(true);
      expect(await entryId(address, "unsubscribe_link")).toBeDefined();
    }
  });

  it("delta review 2-2: a waiting owner's entry or SMS reply is kept when the key returns, beside a link's unsubscribe", async () => {
    const lead = await insertLead(owner.id, org, { email: "waiting-owner@example.test", phone: "0523330020" });
    const emailToken = await sent(org, "lead", lead, "email");
    const smsToken = await sent(org, "lead", lead, "sms");
    await submit(emailToken, "unsubscribe");
    await submit(smsToken, "unsubscribe");
    expect(await serviceBlocked(org, "email", "waiting-owner@example.test")).toBe(false);
    expect(await serviceBlocked(org, "sms", "0523330020")).toBe(false);
    await setKey(null);
    try {
      await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'email', array['waiting-owner@example.test'], 'complaint')", [org]));
      await asService((q) => q("select public.sms_inbound_optout($1, '0523330020', 'הסר')", [org]));
    } finally {
      await setKey(KEY);
    }
    // the hourly backfill: waiting consents and blocklist entries get their hashes
    await asAdmin((q) => q("select app.consent_backfill_hashes()"));
    const active = await asAdmin(
      async (q) =>
        (
          await q<{ reason: string; channel: string }>(
            `select reason, channel from public.consent_blocklist
              where organization_id = $1 and removed_at is null
                and address_hash in (app.consent_address_hash($1, 'email', 'waiting-owner@example.test', 1::smallint),
                                     app.consent_address_hash($1, 'phone', '+972523330020', 1::smallint))
              order by channel`,
            [org],
          )
        ).rows,
    );
    expect(active).toEqual([
      { reason: "complaint", channel: "email" },
      { reason: "sms_reply", channel: "sms" },
    ]);
    expect(await serviceBlocked(org, "email", "waiting-owner@example.test")).toBe(true);
    expect(await serviceBlocked(org, "sms", "0523330020")).toBe(true);
    expect(await relistOk(org, "email", "waiting-owner@example.test")).toBe(false);
    expect(await relistOk(org, "sms", "0523330020")).toBe(false);
    expect(await submit(emailToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
  });

  it("an erasure of the address is never lifted from the page", async () => {
    const lead = await insertLead(owner.id, org, { email: "erased@example.test" });
    const token = await sent(org, "lead", lead, "email");
    await submit(token, "unsubscribe");
    // a privacy erasure's do-not-contact on the same address (the server path of app.audit_erase_request)
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'email', 'withdrawn', 'erasure')", [org, lead]));
    expect(await serviceBlocked(org, "email", "erased@example.test")).toBe(true);
    expect(await relistOk(org, "email", "erased@example.test")).toBe(false);
    expect(await submit(token, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect(await suppressed(org, "email", "erased@example.test")).toBe(true);
  });

  it("without the consent key nothing can be turned on (fail closed); a replaced token's 'remove from every channel' removes its own channel only", async () => {
    const lead = await insertLead(owner.id, org, { email: "nokey2@example.test", phone: "0523330011" });
    // a staff link (the one that may give a first consent, (254) ב)
    const token = await mint(owner.id, org, "lead", lead, "email");
    await setKey(null);
    try {
      expect(channelState(await read(token), "email")).toEqual({ channel: "email", state: "unknown", can_turn_on: false });
      expect(await submit(token, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    } finally {
      await setKey(KEY);
    }
    expect(await entries(org, "lead_id", lead)).toEqual([]);
    // an older token: unsubscribe_all reaches only its own channel and address
    await sent(org, "lead", lead, "email");
    expect(await submit(token, "unsubscribe_all")).toEqual({ status: "done" });
    expect(await suppressed(org, "email", "nokey2@example.test")).toBe(true);
    expect(await suppressed(org, "sms", "0523330011")).toBe(false);
  });

  it("an opt-out still waiting for its hash on the channel blocks the re-subscribe (fail closed)", async () => {
    // its own business, because a waiting opt-out makes every address of that channel there uncheckable
    const ownerC = await createUser("prefs-owner-c");
    const orgC = await createOrg(ownerC.id, "עסק המתנה");
    const lead = await insertLead(ownerC.id, orgC, { email: "wait@example.test" });
    const token = await sent(orgC, "lead", lead, "email");
    await submit(token, "unsubscribe");
    expect(await relistOk(orgC, "email", "wait@example.test")).toBe(true);
    const other = await insertLead(ownerC.id, orgC, { email: "pending@example.test" });
    await setKey(null);
    try {
      await asUser(ownerC.id, (q) =>
        q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'withdrawn', 'manual', 'בשיחה')", [orgC, other]),
      );
    } finally {
      await setKey(KEY);
    }
    expect(await relistOk(orgC, "email", "wait@example.test")).toBe(false);
    expect(await submit(token, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
  });

  it("delta review 2: the read rule lets a 'preferences' grant end only the person's own opt-outs; every other source keeps its answer", async () => {
    // entries written straight into the register (triggers off), so the read rule is judged alone
    const ownerD = await createUser("prefs-owner-d");
    const orgD = await createOrg(ownerD.id, "עסק קריאה");
    const stateAfter = (steps: { state: string; source: string; method?: string; lift?: string }[]) =>
      asAdmin(async (q) => {
        const hash = (await q<{ h: string }>("select app.consent_address_hash($1, 'email', $2, 1::smallint) as h", [orgD, `r${Math.random()}@example.test`])).rows[0].h;
        await q("set local session_replication_role = replica");
        let i = 0;
        for (const step of steps) {
          i += 1;
          await q(
            `insert into public.consents (organization_id, subject_type, subject_id, channel, state, source, method, lift_method, address_hash, hash_version, created_at)
             values ($1, 'lead', gen_random_uuid(), 'email', $2, $3, $4, $5, $6, 1, now() - interval '1 hour' + make_interval(secs => $7))`,
            [orgD, step.state, step.source, step.method ?? null, step.lift ?? null, hash, i],
          );
        }
        return (await q<{ s: string | null }>("select app.consent_register_state($1, 'email', $2, null, null) as s", [orgD, hash])).rows[0].s;
      });
    const link = { state: "withdrawn", source: "unsubscribe", method: "קישור הסרה" };
    const page = { state: "granted", source: "preferences" };
    expect(await stateAfter([link, page])).toBe("in");
    expect(await stateAfter([{ state: "withdrawn", source: "preferences" }, page])).toBe("in");
    // (250) ב: a staff link's opt-outs count as the page's; (254) ב: its grant is read exactly as the page's (021221's
    // "only when the run began from an 'in'" is gone): it ends a run of the person's own opt-outs, nothing else
    const staffPage = { state: "granted", source: "preferences_staff_link" };
    expect(await stateAfter([staffPage])).toBe("in");
    expect(await stateAfter([link, staffPage])).toBe("in");
    expect(await stateAfter([{ state: "granted", source: "form" }, link, staffPage])).toBe("in");
    expect(await stateAfter([{ state: "granted", source: "import" }, link, staffPage])).toBe("in");
    expect(await stateAfter([{ state: "granted", source: "form" }, link, staffPage, link, staffPage])).toBe("in");
    expect(await stateAfter([link, staffPage, link, staffPage])).toBe("in");
    expect(await stateAfter([{ state: "withdrawn", source: "unsubscribe", method: 'תשובת "הסר" ב-SMS' }, staffPage])).toBe("out");
    expect(await stateAfter([{ state: "denied", source: "import" }, link, staffPage])).toBe("out");
    expect(await stateAfter([{ state: "withdrawn", source: "preferences_staff_link", method: "קישור הסרה" }, page])).toBe("in");
    expect(await stateAfter([{ state: "withdrawn", source: "manual", method: "בשיחה" }, link, staffPage])).toBe("out");
    expect(await stateAfter([link, { state: "withdrawn", source: "erasure" }, staffPage])).toBe("blocked");
    // a staff opt-out (before or after the link's) is never ended by the page
    expect(await stateAfter([{ state: "withdrawn", source: "manual", method: "בשיחה" }, link, page])).toBe("out");
    expect(await stateAfter([link, { state: "withdrawn", source: "manual", method: "בשיחה" }, page])).toBe("out");
    // an SMS reply's opt-out, an import's denial, an erasure: not the person's own link unsubscribe
    expect(await stateAfter([{ state: "withdrawn", source: "unsubscribe", method: 'תשובת "הסר" ב-SMS' }, page])).toBe("out");
    expect(await stateAfter([{ state: "denied", source: "import" }, page])).toBe("out");
    expect(await stateAfter([link, { state: "withdrawn", source: "erasure" }, page])).toBe("blocked");
    // the earlier rules unchanged
    expect(await stateAfter([{ state: "withdrawn", source: "manual", method: "בשיחה" }, { state: "granted", source: "form" }])).toBe("in");
    expect(await stateAfter([{ state: "withdrawn", source: "manual", method: "בשיחה" }, { state: "granted", source: "manual", method: "x", lift: "signed_form" }])).toBe("in");
    expect(await stateAfter([{ state: "withdrawn", source: "manual", method: "בשיחה" }, { state: "granted", source: "import" }])).toBe("out");
    expect(await stateAfter([{ state: "withdrawn", source: "erasure" }, { state: "granted", source: "form" }])).toBe("in");
    expect(await stateAfter([{ state: "granted", source: "manual", method: "x" }])).toBe("in");
    // after a lift, a new opt-out starts a new tally
    expect(await stateAfter([{ state: "withdrawn", source: "manual", method: "בשיחה" }, { state: "granted", source: "form" }, link, page])).toBe("in");
  });

  it("an address the business blocklisted can never be turned on from the page", async () => {
    const lead = await insertLead(owner.id, org, { email: "blocked@example.test", phone: "0523330004" });
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'sms', array['0523330004'], 'person_request')", [org]));
    const token = await sent(org, "lead", lead, "sms");
    expect(channelState(await read(token), "sms")).toEqual({ channel: "sms", state: "out", can_turn_on: false });
    expect(await submit(token, "preferences", [{ channel: "sms", on: true }])).toEqual({ status: "saved", results: [{ channel: "sms", result: "refused" }] });
    expect(await entries(org, "lead_id", lead)).toEqual([]);
    // a channel the page does not show is refused as well; bad input is 22023
    expect(await submit(token, "preferences", [{ channel: "phone", on: true }])).toEqual({ status: "saved", results: [{ channel: "phone", result: "refused" }] });
    expect((await pgError(submit(token, "preferences", [{ channel: "sms", on: "yes" }]))).code).toBe("22023");
    expect((await pgError(submit(token, "preferences", []))).code).toBe("22023");
    expect((await pgError(submit(token, "other"))).code).toBe("22023");
  });

  it("a replaced token still unsubscribes its own address, and does nothing else", async () => {
    const lead = await insertLead(owner.id, org, { email: "old@example.test", phone: "0523330005" });
    const first = await sent(org, "lead", lead, "email");
    const second = await sent(org, "lead", lead, "email");
    expect(first).not.toBe(second);
    const old = await read(first);
    expect(old.full).toBe(false);
    expect(old.channels).toEqual([{ channel: "email", state: "unknown", can_turn_on: false }]);
    expect(await submit(first, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect(await submit(first, "preferences", [{ channel: "sms", on: false }])).toEqual({ status: "saved", results: [{ channel: "sms", result: "refused" }] });
    expect(await entries(org, "lead_id", lead)).toEqual([]);
    expect(await submit(first, "unsubscribe")).toEqual({ status: "done" });
    expect(await suppressed(org, "email", "old@example.test")).toBe(true);
    // the new token shows the full page
    expect((await read(second)).full).toBe(true);
  });

  it("the address the token was made for is unsubscribed even after the record changed its address or was purged", async () => {
    const lead = await insertLead(owner.id, org, { email: "moved@example.test" });
    const token = await sent(org, "lead", lead, "email");
    await asUser(owner.id, (q) => q("update public.leads set email = 'new@example.test' where id = $1", [lead]));
    expect(await submit(token, "unsubscribe")).toEqual({ status: "done" });
    // the old address is blocked; the record's new address is not (its consent entry would be about the new one)
    expect(await suppressed(org, "email", "moved@example.test")).toBe(true);
    expect(await suppressed(org, "email", "new@example.test")).toBe(false);
    expect(await entries(org, "lead_id", lead)).toEqual([]);

    const gone = await insertLead(owner.id, org, { email: "gone@example.test" });
    const goneToken = await sent(org, "lead", gone, "email");
    await asAdmin((q) => q("delete from public.leads where id = $1", [gone]));
    expect((await read(goneToken)).channels).toEqual([{ channel: "email", state: "unknown", can_turn_on: false }]);
    expect(await submit(goneToken, "unsubscribe")).toEqual({ status: "done" });
    expect(await suppressed(org, "email", "gone@example.test")).toBe(true);
  });

  it("never reaches another business: the same address there is untouched", async () => {
    const lead = await insertLead(owner.id, org, { email: "shared@example.test", phone: "0523330006" });
    const other = await insertLead(ownerB.id, orgB, { email: "shared@example.test", phone: "0523330006" });
    const token = await mint(owner.id, org, "lead", lead, "email");
    const blocksB = (await blocks(orgB)).length;
    expect(await submit(token, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "saved" }] });
    await submit(token, "unsubscribe_all");
    expect(await entries(orgB, "lead_id", other)).toEqual([]);
    expect((await blocks(orgB)).length).toBe(blocksB);
    expect(await suppressed(orgB, "email", "shared@example.test")).toBe(false);
    expect((await read(token)).business).toBe("עסק העדפות");
  });

  it("limits: 60 calls per sender, then 120 per link, in 10 minutes", async () => {
    const lead = await insertLead(owner.id, org, { email: "rate@example.test" });
    const token = await sent(org, "lead", lead, "email");
    const ip = "a".repeat(64);
    for (let i = 0; i < 60; i += 1) expect((await read(token, ip)).rate_limited).toBeUndefined();
    expect(await read(token, ip)).toEqual({ rate_limited: true });
    expect(await submit(token, "unsubscribe", null, ip)).toEqual({ rate_limited: true });
    // another sender still gets through until the link's window is full
    for (let i = 0; i < 58; i += 1) expect((await read(token, "b".repeat(64))).rate_limited).toBeUndefined();
    expect(await read(token, "c".repeat(64))).toEqual({ rate_limited: true });
  });

  it("the sender's mint is bound to the job's live lease and the job's own customer", async () => {
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email) values ($1, 'נועה', 'noa@example.test') returning id", [org])).rows[0].id,
    );
    const job = await asAdmin(
      async (q) =>
        (
          await q<{ id: string; lease_id: string }>(
            `insert into app.jobs (organization_id, kind, payload, status, lease_id, locked_until)
             values ($1, 'message.send', $2, 'running', gen_random_uuid(), now() + interval '1 minute') returning id, lease_id`,
            [org, JSON.stringify({ channel: "email", contact_id: contact, message_type: "marketing" })],
          )
        ).rows[0],
    );
    const forJob = (lease: string) =>
      asService(async (q) => (await q<{ r: Record<string, string> }>("select public.consent_preference_link_for_job($1, $2) as r", [job.id, lease])).rows[0].r);
    expect(await forJob("11111111-1111-4111-8111-111111111111")).toEqual({ refused: "stale" });
    const minted = await forJob(job.lease_id);
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect((await read(minted.token)).channel).toBe("email");
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where id = $1", [job.id]));
    expect(await forJob(job.lease_id)).toEqual({ refused: "stale" });
    // review 3: a service message carries no unsubscribe link
    const serviceJob = await asAdmin(
      async (q) =>
        (
          await q<{ id: string; lease_id: string }>(
            `insert into app.jobs (organization_id, kind, payload, status, lease_id, locked_until)
             values ($1, 'message.send', $2, 'running', gen_random_uuid(), now() + interval '1 minute') returning id, lease_id`,
            [org, JSON.stringify({ channel: "email", contact_id: contact, message_type: "requested_document" })],
          )
        ).rows[0],
    );
    expect(
      await asService(async (q) => (await q<{ r: unknown }>("select public.consent_preference_link_for_job($1, $2) as r", [serviceJob.id, serviceJob.lease_id])).rows[0].r),
    ).toEqual({ refused: "service_type" });
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where id = $1", [serviceJob.id]));
  });

  it("(250) ב, (254) ב: a link a person on the staff copied gives a first consent and re-subscribes the person's own unsubscribe for 7 days, with source 'preferences_staff_link'; who copied it and when is audited", async () => {
    const lead = await insertLead(owner.id, org, { email: "staffcopy@example.test" });
    const staffToken = await mint(owner.id, org, "lead", lead, "email");
    // who and when: the link's audit entry names the person and its time
    const audit = await asAdmin(
      async (q) =>
        (
          await q<{ actor_id: string; fresh: boolean }>(
            "select actor_id, created_at > now() - interval '1 minute' as fresh from public.audit_log where organization_id = $1 and action = 'consent_link' and entity_id = $2",
            [org, lead],
          )
        ).rows,
    );
    expect(audit).toEqual([{ actor_id: owner.id, fresh: true }]);
    const page = await read(staffToken);
    expect(page.unsubscribe_only).toBe(false);
    // owner (254) ב: a staff link may give a first consent on a channel never consented, on the record's own address
    expect(channelState(page, "email")).toEqual({ channel: "email", state: "unknown", can_turn_on: true });
    // only the token's own channel (the record has no phone here, and an email link never reaches SMS)
    expect(await submit(staffToken, "preferences", [{ channel: "sms", on: true }, { channel: "email", on: true }])).toEqual({
      status: "saved",
      results: [
        { channel: "sms", result: "refused" },
        { channel: "email", result: "saved" },
      ],
    });
    expect(await entries(org, "lead_id", lead)).toEqual([
      { channel: "email", state: "granted", source: "preferences_staff_link", method: "דף העדפות", wording: PREFERENCES_CONSENT_WORDING, wording_version: PREFERENCES_CONSENT_VERSION },
    ]);
    expect(await suppressed(org, "email", "staffcopy@example.test")).toBe(false);
    expect(channelState(await read(staffToken), "email")).toEqual({ channel: "email", state: "in", can_turn_on: false });
    // the one-click unsubscribe through it: the staff source, the blocklist entry as for every link
    expect(await submit(staffToken, "unsubscribe")).toEqual({ status: "done" });
    expect((await entries(org, "lead_id", lead)).at(-1)).toEqual({
      channel: "email",
      state: "withdrawn",
      source: "preferences_staff_link",
      method: "קישור הסרה",
      wording: null,
      wording_version: null,
    });
    expect(await suppressed(org, "email", "staffcopy@example.test")).toBe(true);
    // the person's own unsubscribe is re-subscribed through it (plain relist_ok)
    expect(await relistOk(org, "email", "staffcopy@example.test")).toBe(true);
    expect(channelState(await read(staffToken), "email")).toEqual({ channel: "email", state: "out", can_turn_on: true });
    expect(await submit(staffToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "saved" }] });
    expect((await entries(org, "lead_id", lead)).map((e) => `${e.state}:${e.source}`)).toEqual([
      "granted:preferences_staff_link",
      "withdrawn:preferences_staff_link",
      "granted:preferences_staff_link",
    ]);
    expect(await suppressed(org, "email", "staffcopy@example.test")).toBe(false);
    // app.consent_prepare: a server write of the staff source never passes another opt-out (here a manual one)
    const srvLead = await insertLead(owner.id, org, { email: "staffsrv@example.test" });
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'withdrawn', 'manual', 'בשיחה')", [org, srvLead]),
    );
    expect(
      (
        await pgError(
          asAdmin((q) =>
            q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'granted', 'preferences_staff_link', 'דף העדפות')", [org, srvLead]),
          ),
        )
      ).hint,
    ).toBe("consent:optout_locked");
    // after the link a message carries unsubscribed a never-consented address, a staff copy re-subscribes it (the person's
    // own unsubscribe, (254) ב)
    const msgLead = await insertLead(owner.id, org, { email: "staffmsg@example.test" });
    expect(await submit(await sent(org, "lead", msgLead, "email"), "unsubscribe")).toEqual({ status: "done" });
    const msgStaff = await mint(owner.id, org, "lead", msgLead, "email");
    expect(channelState(await read(msgStaff), "email")).toEqual({ channel: "email", state: "out", can_turn_on: true });
    expect(await submit(msgStaff, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "saved" }] });
    expect(await suppressed(org, "email", "staffmsg@example.test")).toBe(false);

    // a real consent (a public form's 'granted'), then the person's own unsubscribe through the staff link: it returns to it
    const formLead = await insertLead(owner.id, org, { email: "staffform@example.test" });
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'email', 'granted', 'form')", [org, formLead]));
    const formStaff = await mint(owner.id, org, "lead", formLead, "email");
    expect(channelState(await read(formStaff), "email")).toEqual({ channel: "email", state: "in", can_turn_on: false });
    expect(await submit(formStaff, "unsubscribe")).toEqual({ status: "done" });
    expect(await relistOk(org, "email", "staffform@example.test")).toBe(true);
    expect(channelState(await read(formStaff), "email")).toEqual({ channel: "email", state: "out", can_turn_on: true });
    expect(await submit(formStaff, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "saved" }] });
    expect((await entries(org, "lead_id", formLead)).at(-1)).toEqual({
      channel: "email",
      state: "granted",
      source: "preferences_staff_link",
      method: "דף העדפות",
      wording: PREFERENCES_CONSENT_WORDING,
      wording_version: PREFERENCES_CONSENT_VERSION,
    });
    // once 'in', nothing more to turn on
    expect(channelState(await read(formStaff), "email")).toEqual({ channel: "email", state: "in", can_turn_on: false });
    expect(await suppressed(org, "email", "staffform@example.test")).toBe(false);
    // the page's "off" takes the source too, and the next return is still grounded in the form's consent
    expect(await submit(formStaff, "preferences", [{ channel: "email", on: false }])).toEqual({ status: "saved", results: [{ channel: "email", result: "saved" }] });
    expect((await entries(org, "lead_id", formLead)).at(-1)).toMatchObject({ state: "withdrawn", source: "preferences_staff_link", method: "דף העדפות" });
    expect(channelState(await read(formStaff), "email")).toEqual({ channel: "email", state: "out", can_turn_on: true });
    // a staff copy replaced by another one is an older token: no full page, and it keeps the earlier sources
    const newer = await mint(owner.id, org, "lead", formLead, "email");
    const replaced = await read(formStaff);
    expect({ full: replaced.full, unsubscribe_only: replaced.unsubscribe_only }).toEqual({ full: false, unsubscribe_only: false });
    expect(channelState(replaced, "email")?.can_turn_on).toBe(false);
    expect(await submit(formStaff, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect((await read(newer)).full).toBe(true);
    // the link a message carries is unchanged: never consented, its own unsubscribe, then its own turn-on
    const plainMsg = await insertLead(owner.id, org, { email: "msgplain@example.test" });
    const msgToken = await sent(org, "lead", plainMsg, "email");
    expect(await submit(msgToken, "unsubscribe")).toEqual({ status: "done" });
    expect(channelState(await read(msgToken), "email")).toEqual({ channel: "email", state: "out", can_turn_on: true });
    expect(await submit(msgToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "saved" }] });
    expect((await entries(org, "lead_id", plainMsg)).at(-1)).toMatchObject({ state: "granted", source: "preferences" });
  });

  it("(250) ב: after 7 days a staff link only unsubscribes; the link a message carries keeps turning on", async () => {
    const age = (token: string, interval: string) =>
      asAdmin((q) =>
        q(`update app.consent_preference_tokens set created_at = now() - interval '${interval}' where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`, [token]),
      );
    const lead = await insertLead(owner.id, org, { email: "staffold@example.test" });
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'email', 'granted', 'form')", [org, lead]));
    const staffToken = await mint(owner.id, org, "lead", lead, "email");
    expect(await submit(staffToken, "unsubscribe")).toEqual({ status: "done" });
    await age(staffToken, "6 days 23 hours");
    expect((await read(staffToken)).unsubscribe_only).toBe(false);
    expect(channelState(await read(staffToken), "email")).toEqual({ channel: "email", state: "out", can_turn_on: true });
    await age(staffToken, "7 days");
    const page = await read(staffToken);
    expect(page.full).toBe(true);
    expect(page.unsubscribe_only).toBe(true);
    // the person's own unsubscribe is not lifted through the old staff link; unsubscribing still works
    expect(channelState(page, "email")).toEqual({ channel: "email", state: "out", can_turn_on: false });
    expect(await submit(staffToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect((await entries(org, "lead_id", lead)).map((e) => e.state)).toEqual(["granted", "withdrawn"]);
    expect(await submit(staffToken, "preferences", [{ channel: "email", on: false }])).toEqual({ status: "saved", results: [{ channel: "email", result: "unchanged" }] });
    expect(await suppressed(org, "email", "staffold@example.test")).toBe(true);
    expect(await submit(staffToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    // the link a message carries is not bound to the 7 days: the person turns their own unsubscribe back on
    const sentToken = await sent(org, "lead", lead, "email");
    await age(sentToken, "30 days");
    const sentPage = await read(sentToken);
    expect(sentPage.unsubscribe_only).toBe(false);
    expect(channelState(sentPage, "email")).toEqual({ channel: "email", state: "out", can_turn_on: true });
    expect(await submit(sentToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "saved" }] });
    expect((await entries(org, "lead_id", lead)).at(-1)).toMatchObject({ state: "granted", source: "preferences" });
    expect(await suppressed(org, "email", "staffold@example.test")).toBe(false);
    // the replaced staff token says nothing of staff
    expect((await read(staffToken)).unsubscribe_only).toBe(false);
    // (254) ב: a first consent through a staff link only within its 7 days
    const fresh = await insertLead(owner.id, org, { email: "stafffresh@example.test" });
    const freshToken = await mint(owner.id, org, "lead", fresh, "email");
    await age(freshToken, "6 days 23 hours");
    expect(channelState(await read(freshToken), "email")).toEqual({ channel: "email", state: "unknown", can_turn_on: true });
    await age(freshToken, "7 days");
    expect(channelState(await read(freshToken), "email")).toEqual({ channel: "email", state: "unknown", can_turn_on: false });
    expect(await submit(freshToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect(await entries(org, "lead_id", fresh)).toEqual([]);
    expect(await submit(freshToken, "unsubscribe")).toEqual({ status: "done" });
    expect(await suppressed(org, "email", "stafffresh@example.test")).toBe(true);
  });

  it("(254) ב: a staff link's grant after an import's consent stands on its own once the import is undone", async () => {
    const email = "staffundo@example.test";
    const hashOf = (q: (sql: string, params?: unknown[]) => Promise<{ rows: { h: string }[] }>) =>
      q("select app.consent_address_hash($1, 'email', $2, 1::smallint) as h", [org, email]);
    const stateOf = () =>
      asAdmin(async (q) => {
        const h = (await hashOf(q)).rows[0].h;
        return (await q<{ s: string | null }>("select app.consent_state_of($1, 'email', $2, null, null) as s", [org, h])).rows[0].s;
      });
    const granted = () => asAdmin(async (q) => (await q<{ g: boolean | null }>("select app.consent_granted($1, 'email', $2) as g", [org, email])).rows[0].g);
    // an import with a declared consent column writes the address's 'granted'
    const job = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows, consent_method, consent_note)
           values ($1, 'lead', 'list.csv', 'skip', 1, 'website_form', 'רשימת האתר') returning id`,
          [org],
        )
      ).rows[0].id,
    );
    const lead = await insertLead(owner.id, org, { email, import_job_id: job });
    expect(
      await asUser(owner.id, async (q) =>
        (await q<{ r: string[] }>("select public.import_record_consents($1, $2, $3) as r", [org, job, JSON.stringify([{ record_id: lead, channel: "email", state: "granted", address: email }])])).rows[0].r,
      ),
    ).toEqual(["written"]);
    await asUser(owner.id, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
    // the person's own unsubscribe through a staff link, then the staff link's return to that consent
    const staffToken = await mint(owner.id, org, "lead", lead, "email");
    expect(await submit(staffToken, "unsubscribe")).toEqual({ status: "done" });
    expect(channelState(await read(staffToken), "email")).toEqual({ channel: "email", state: "out", can_turn_on: true });
    expect(await submit(staffToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "saved" }] });
    expect(await stateOf()).toBe("in");
    expect(await granted()).toBe(true);
    // the import is undone: its 'granted' is cancelled. (254) ב: the staff link's grant no longer leans on it (021221's
    // o_had_in rule is gone); it is read as a page grant: the register is now the person's own unsubscribe, then the
    // person's own grant through the staff link, so the state stays 'in'. Acceptable: the owner allows a first consent
    // through a staff link on the record's own address, which is exactly what that grant is once the import is gone
    expect(await asUser(owner.id, async (q) => (await q<{ r: Record<string, number> }>("select public.undo_import($1, $2) as r", [org, job])).rows[0].r)).toMatchObject({
      consents: 1,
    });
    expect(await stateOf()).toBe("in");
    expect(await granted()).toBe(true);
    expect(await suppressed(org, "email", email)).toBe(false);
    // the record back from the bin: nothing more to turn on
    await asAdmin((q) => q("update public.leads set deleted_at = null where id = $1", [lead]));
    expect(channelState(await read(staffToken), "email")).toEqual({ channel: "email", state: "in", can_turn_on: false });
    expect(await submit(staffToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "unchanged" }] });
    // "off" records the person's unsubscribe on the blocklist again (the staff turn-on had marked the link's entry removed)
    expect(await submit(staffToken, "preferences", [{ channel: "email", on: false }])).toEqual({ status: "saved", results: [{ channel: "email", result: "saved" }] });
    expect(await stateOf()).toBe("listed");
    expect(await granted()).toBe(false);
  });

  it("(250) ב, (231): a staff link never lifts a manual opt-out, a manual blocklist entry or a privacy erasure", async () => {
    // a manual opt-out before the staff link's own unsubscribe
    const manual = await insertLead(owner.id, org, { email: "staffmanual@example.test" });
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'withdrawn', 'manual', 'בשיחה')", [org, manual]),
    );
    const manualToken = await mint(owner.id, org, "lead", manual, "email");
    expect(channelState(await read(manualToken), "email")).toEqual({ channel: "email", state: "out", can_turn_on: false });
    expect(await submit(manualToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect(await suppressed(org, "email", "staffmanual@example.test")).toBe(true);

    // an owner's blocklist entry, alone and beside the person's own unsubscribe
    const listed = await insertLead(owner.id, org, { email: "stafflisted@example.test" });
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'email', array['stafflisted@example.test'], 'person_request')", [org]));
    const listedToken = await mint(owner.id, org, "lead", listed, "email");
    expect(channelState(await read(listedToken), "email")).toEqual({ channel: "email", state: "out", can_turn_on: false });
    expect(await submit(listedToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    await submit(listedToken, "unsubscribe");
    expect(await relistOk(org, "email", "stafflisted@example.test")).toBe(false);
    expect(await submit(listedToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect(await suppressed(org, "email", "stafflisted@example.test")).toBe(true);
    expect(await serviceBlocked(org, "email", "stafflisted@example.test")).toBe(true);

    // a privacy erasure's do-not-contact after the staff link's unsubscribe
    const erased = await insertLead(owner.id, org, { email: "stafferased@example.test" });
    const erasedToken = await mint(owner.id, org, "lead", erased, "email");
    await submit(erasedToken, "unsubscribe");
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'email', 'withdrawn', 'erasure')", [org, erased]));
    expect(await relistOk(org, "email", "stafferased@example.test")).toBe(false);
    expect(channelState(await read(erasedToken), "email")).toEqual({ channel: "email", state: "out", can_turn_on: false });
    expect(await submit(erasedToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect(await suppressed(org, "email", "stafferased@example.test")).toBe(true);
    expect(await serviceBlocked(org, "email", "stafferased@example.test")).toBe(true);
    // review L2: an SMS reply's opt-out ("הסר") and an import's denial are never turned on from a staff link
    const smsLead = await insertLead(owner.id, org, { phone: "0523330040" });
    await asService((q) => q("select public.sms_inbound_optout($1, '0523330040', 'הסר')", [org]));
    const smsToken = await mint(owner.id, org, "lead", smsLead, "sms");
    expect(channelState(await read(smsToken), "sms")).toEqual({ channel: "sms", state: "out", can_turn_on: false });
    expect(await submit(smsToken, "preferences", [{ channel: "sms", on: true }])).toEqual({ status: "saved", results: [{ channel: "sms", result: "refused" }] });
    await submit(smsToken, "unsubscribe");
    expect(await relistOk(org, "sms", "0523330040")).toBe(false);
    expect(await submit(smsToken, "preferences", [{ channel: "sms", on: true }])).toEqual({ status: "saved", results: [{ channel: "sms", result: "refused" }] });
    expect(await suppressed(org, "sms", "0523330040")).toBe(true);
    const denied = await insertLead(owner.id, org, { email: "staffdenied@example.test" });
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'email', 'denied', 'import')", [org, denied]));
    const deniedToken = await mint(owner.id, org, "lead", denied, "email");
    expect(channelState(await read(deniedToken), "email")).toEqual({ channel: "email", state: "out", can_turn_on: false });
    await submit(deniedToken, "unsubscribe");
    expect(await relistOk(org, "email", "staffdenied@example.test")).toBe(false);
    expect(await submit(deniedToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect(await suppressed(org, "email", "staffdenied@example.test")).toBe(true);
    // (254) ב: a first consent ('unknown' on this record) is judged across the business: another record's manual opt-out or
    // erasure of the same address blocks it
    const otherOut = await insertLead(owner.id, org, { email: "staffacross@example.test" });
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'withdrawn', 'manual', 'בשיחה')", [org, otherOut]),
    );
    const across = await insertLead(owner.id, org, { email: "staffacross@example.test" });
    const acrossToken = await mint(owner.id, org, "lead", across, "email");
    expect(channelState(await read(acrossToken), "email")).toEqual({ channel: "email", state: "out", can_turn_on: false });
    expect(await submit(acrossToken, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect(await entries(org, "lead_id", across)).toEqual([]);
    const otherErased = await insertLead(owner.id, org, { email: "staffacross2@example.test" });
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'email', 'withdrawn', 'erasure')", [org, otherErased]));
    const across2 = await insertLead(owner.id, org, { email: "staffacross2@example.test" });
    const across2Token = await mint(owner.id, org, "lead", across2, "email");
    expect(channelState(await read(across2Token), "email")).toEqual({ channel: "email", state: "out", can_turn_on: false });
    expect(await submit(across2Token, "preferences", [{ channel: "email", on: true }])).toEqual({ status: "saved", results: [{ channel: "email", result: "refused" }] });
    expect(await suppressed(org, "email", "staffacross2@example.test")).toBe(true);
    // a person cannot write the staff link's source by hand (policy consents_insert: 'manual' only)
    const plain = await insertLead(owner.id, org, { email: "staffplain@example.test" });
    expect(
      (
        await pgError(
          asUser(owner.id, (q) =>
            q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'granted', 'preferences_staff_link', 'x')", [org, plain]),
          ),
        )
      ).code,
    ).toBe("42501");
  });

  it("(254) ב: no rule reads 021221's staff-only re-subscribe check any more (kept defined, unused)", async () => {
    const callers = await asAdmin(
      async (q) =>
        (
          await q<{ name: string }>(
            `select n.nspname || '.' || p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('app', 'public') and p.proname <> 'consent_preference_staff_relist_ok'
                and (p.prosrc like '%consent_preference_staff_relist_ok%' or p.prosrc like '%o_had_in then%')
              order by 1`,
          )
        ).rows,
    );
    expect(callers).toEqual([]);
    expect(
      await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from pg_proc where proname = 'consent_preference_staff_relist_ok'")).rows[0].n),
    ).toBe(1);
  });

  it("(233) ב: tokens and their address hashes are deleted 24 months after they were made", async () => {
    const lead = await insertLead(owner.id, org, { email: "aged@example.test" });
    const oldToken = await mint(owner.id, org, "lead", lead, "email");
    const newToken = await mint(owner.id, org, "lead", lead, "email");
    await asAdmin((q) =>
      q("update app.consent_preference_tokens set created_at = now() - interval '25 months' where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [oldToken]),
    );
    const purged = await asAdmin(async (q) => (await q<{ n: number }>("select app.run_preference_token_purge() as n")).rows[0].n);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect((await pgError(read(oldToken))).code).toBe("P0002");
    expect((await read(newToken)).full).toBe(true);
  });
});
