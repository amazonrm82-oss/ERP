import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own (the same as 242)
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

/**
 * CNS-06: the business's do-not-market list. Hashes only; owners and admins add and remove; a listed address is
 * suppressed whatever the consents say, and neither a public-form tick, an import nor a person's consent opens it.
 */
describe("blocklist of phones and emails (CNS-06)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;

  const add = (who: U, channel: string, addresses: string[], reason = "person_request") =>
    asUser(who.id, async (q) =>
      (await q<{ r: Row }>("select public.consent_blocklist_add($1, $2, $3, $4) as r", [org, channel, addresses, reason])).rows[0].r,
    );
  const find = (who: U, address: string, inOrg = org) =>
    asUser(who.id, async (q) => (await q<{ r: Row }>("select public.consent_blocklist_find($1, $2) as r", [inOrg, address])).rows[0].r);
  const summary = (who: U) =>
    asUser(who.id, async (q) => (await q<{ r: Row }>("select public.consent_blocklist_summary($1) as r", [org])).rows[0].r);
  const suppressed = (channel: string, value: string) =>
    asAdmin(async (q) => (await q<{ s: boolean | null }>("select app.consent_suppressed($1, $2, $3) as s", [org, channel, value])).rows[0].s);
  const locked = (lead: string, channel: string, address: string) =>
    asAdmin(
      async (q) =>
        (await q<{ l: boolean }>("select app.consent_address_locked($1, $2, null, $3, $4) as l", [org, lead, channel, address])).rows[0].l,
    );
  const manual = (who: U, lead: string, channel: string, extra = "") =>
    asUser(who.id, (q) =>
      q(
        `insert into public.consents (organization_id, lead_id, channel, state, source, method${extra ? ", lift_method, lift_note" : ""})
         values ($1, $2, $3, 'granted', 'manual', 'אמר בטלפון'${extra ? ", 'signed_form', 'חתם שוב'" : ""})`,
        [org, lead, channel],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("bl-owner");
    org = await createOrg(owner.id, "עסק חסימות");
    admin = await addMember(org, owner.id, "admin", "bl-admin");
    manager = await addMember(org, owner.id, "manager", "bl-manager");
    member = await addMember(org, owner.id, "member", "bl-member");
    viewer = await addMember(org, owner.id, "viewer", "bl-viewer");
    outsider = await createUser("bl-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  it("owners and admins add; everyone else is refused; the entry holds a hash, never the address", async () => {
    const r = await add(owner, "all", ["050-7100001", " Block@Example.TEST ", "", "not a phone", "050-7100001"]);
    expect(r).toEqual({ added: 2, existing: 1, invalid: [4] });
    for (const who of [manager, member, viewer, outsider]) {
      expect((await pgError(add(who, "sms", ["050-7100002"]))).code, who.email).toBe("42501");
    }
    const rows = await asAdmin(
      async (q) =>
        (
          await q<Row>("select kind, channel, address_hash, reason, added_by from public.consent_blocklist where organization_id = $1 order by kind", [org])
        ).rows,
    );
    expect(rows).toEqual([
      { kind: "email", channel: "all", address_hash: hmac(`${org}:email:block@example.test`), reason: "person_request", added_by: owner.id },
      { kind: "phone", channel: "all", address_hash: hmac(`${org}:phone:+972507100001`), reason: "person_request", added_by: owner.id },
    ]);
    // nothing in the database holds the plain address
    expect(await asAdmin((q) => count(q, "select 1 from app.consent_blocklist_pending where organization_id = $1", [org]))).toBe(0);
    // one audit entry with counts only
    const audit = await asAdmin(
      async (q) =>
        (await q<{ changes: Row }>("select changes from public.audit_log where organization_id = $1 and action = 'consent_blocklist_add'", [org])).rows,
    );
    expect(audit).toEqual([{ changes: { channel: "all", reason: "person_request", added: 2, existing: 1 } }]);
  });

  it("the hash is never selectable; only owners and admins see the rows, and only their own business's", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("select address_hash from public.consent_blocklist")))).code).toBe("42501");
    expect(await asUser(admin.id, (q) => count(q, "select id from public.consent_blocklist where organization_id = $1", [org]))).toBe(2);
    for (const who of [manager, member, viewer, outsider]) {
      expect(await asUser(who.id, (q) => count(q, "select id from public.consent_blocklist")), who.email).toBe(0);
    }
    for (const verb of [
      "insert into public.consent_blocklist (organization_id, kind, channel, reason) values ($1, 'phone', 'sms', 'other')",
      "update public.consent_blocklist set reason = 'other' where organization_id = $1",
      "delete from public.consent_blocklist where organization_id = $1",
    ]) {
      expect((await pgError(asUser(owner.id, (q) => q(verb, [org])))).code, verb).toBe("42501");
    }
    // the reading functions are for owners and admins of that business
    for (const who of [member, viewer, outsider]) {
      expect((await pgError(find(who, "050-7100001"))).code, who.email).toBe("42501");
      expect((await pgError(summary(who))).code, who.email).toBe("42501");
    }
    expect((await pgError(find(owner, "050-7100001", otherOrg))).code).toBe("42501");
  });

  it("a channel needs its kind; a whole-kind entry covers each channel; a channel entry covers only itself", async () => {
    expect(await add(admin, "sms", ["only-email@example.test", "050-7100003"])).toEqual({ added: 1, existing: 0, invalid: [1] });
    expect(await add(admin, "whatsapp", ["050-7100001"])).toEqual({ added: 0, existing: 1, invalid: [] });
    expect(await suppressed("sms", "050-7100003")).toBe(true);
    expect(await suppressed("whatsapp", "050-7100003")).toBe(false);
    for (const channel of ["sms", "whatsapp", "phone"]) expect(await suppressed(channel, "+972507100001"), channel).toBe(true);
    expect(await suppressed("email", "BLOCK@example.test")).toBe(true);
    // another business's list is its own
    expect(
      await asAdmin(async (q) => (await q<{ s: boolean }>("select app.consent_suppressed($1, 'sms', '050-7100001') as s", [otherOrg])).rows[0].s),
    ).toBe(false);
  });

  it("the list wins over every consent: a granted entry, a form tick, an import and a person's consent never open it", async () => {
    const lead = await insertLead(member.id, org, { full_name: "רשומה", phone: "050-7100001", email: "block@example.test" });
    // a consent the server wrote before (a form tick) does not open a listed address
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'sms', 'granted', 'form')", [org, lead]));
    expect(await suppressed("sms", "050-7100001")).toBe(true);
    // the shared lock of the public form (CAP-07) and the import (CNS-05)
    expect(await locked(lead, "sms", "+972507100001")).toBe(true);
    expect(await locked(lead, "email", "block@example.test")).toBe(true);
    // a person's 'granted': owners and admins learn why; others get the neutral answer
    expect((await pgError(manual(owner, lead, "whatsapp"))).hint).toBe("consent:blocklisted");
    expect((await pgError(manual(admin, lead, "email", "lift"))).hint).toBe("consent:blocklisted");
    expect((await pgError(manual(member, lead, "whatsapp"))).hint).toBe("consent:address_blocked");
    // an opt-out is always accepted
    await asUser(member.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'whatsapp', 'withdrawn', 'manual', 'ביקש')", [org, lead]),
    );
    // the record's own state is the register only
    const own = await asAdmin(
      async (q) =>
        (await q<{ s: string }>("select app.consent_state_of($1, 'sms', $2, $3, null) as s", [org, hmac(`${org}:phone:+972507100001`), lead])).rows[0].s,
    );
    expect(own).toBe("in");
  });

  it("the record's card says the address is blocked: the list to owners and admins, a neutral word to others", async () => {
    const lead = await insertLead(member.id, org, { full_name: "כרטיס", phone: "050-7100001", email: "card@example.test" });
    // the record's own register says "granted" for email (no list entry for that address)
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'email', 'granted', 'form')", [org, lead]));
    const blocks = (who: U, id = lead, kind = "lead") =>
      asUser(who.id, async (q) => (await q<Row>("select channel, block from public.consent_record_blocks($1, $2, $3) order by channel", [org, kind, id])).rows);
    const phoneListed = (word: string) => ["phone", "sms", "whatsapp"].map((channel) => ({ channel, block: word }));
    expect(await blocks(owner)).toEqual(phoneListed("listed"));
    expect(await blocks(admin)).toEqual(phoneListed("listed"));
    for (const who of [manager, member, viewer]) expect(await blocks(who), who.email).toEqual(phoneListed("blocked"));
    // an outsider, and an unknown kind, get nothing
    expect(await asUser(outsider.id, async (q) => (await q("select * from public.consent_record_blocks($1, 'lead', $2)", [org, lead])).rowCount)).toBe(0);
    expect(await blocks(owner, lead, "deal")).toEqual([]);
    // a record the caller may not read answers nothing
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const hidden = await insertLead(owner.id, org, { full_name: "מוסתר", phone: "050-7100001", owner_id: owner.id });
      expect(await blocks(viewer, hidden)).toEqual([]);
      expect(await blocks(owner, hidden)).toEqual(phoneListed("listed"));
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // an opt-out of the same email on another record: the neutral word for everyone
    const other = await insertLead(member.id, org, { full_name: "אחרת", email: "card@example.test" });
    await asUser(member.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'withdrawn', 'manual', 'ביקשה')", [org, other]),
    );
    expect((await blocks(owner)).filter((row) => row.channel === "email")).toEqual([{ channel: "email", block: "blocked" }]);
  });

  it("a public-form tick for a listed address grants nothing", async () => {
    const form = await asUser(owner.id, async (q) =>
      (
        await q<{ token: string }>("insert into public.forms (organization_id, name, marketing_consent_channels) values ($1, 'טופס', '{email,sms}') returning token", [org])
      ).rows[0].token,
    );
    const r = await asService(
      async (q) =>
        (
          await q<{ r: Row }>("select public.intake_submit($1, 'form', $2, null, null, false) as r", [
            form,
            JSON.stringify({ full_name: "שוב", phone: "050-7100003", email: "fresh@example.test", marketing_consent: ["email", "sms"] }),
          ])
        ).rows[0].r,
    );
    const granted = await asAdmin(
      async (q) => (await q<{ channel: string }>("select channel from public.consents where lead_id = $1 and state = 'granted' order by channel", [r.lead_id])).rows,
    );
    // SMS is listed for this phone; the email has no history
    expect(granted.map((row) => row.channel)).toEqual(["email"]);
    expect(await suppressed("sms", "050-7100003")).toBe(true);
  });

  it("the search finds one exact address with its entries and any erasure block; the counts add up", async () => {
    const found = await find(admin, "+972-50-710-0001");
    expect(found).toMatchObject({ valid: true, kind: "phone", checked: true, erasure: false });
    expect((found.entries as Row[]).map((e) => [e.channel, e.reason, e.removed_at])).toEqual([["all", "person_request", null]]);
    expect(await find(admin, "050-7999999")).toMatchObject({ valid: true, entries: [] });
    expect(await find(admin, "hello")).toEqual({ valid: false });
    // a privacy erasure's do-not-contact mark of an address shows next to the list
    const erased = await insertLead(member.id, org, { full_name: "נמחקה", phone: "050-7100009" });
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'sms', 'withdrawn', 'erasure')", [org, erased]));
    expect(await find(owner, "050-7100009")).toMatchObject({ entries: [], erasure: true });
    expect(await summary(owner)).toEqual({ key_present: true, active: 3, by_channel: { all: 2, sms: 1 }, waiting_hash: 0, removed: 0 });
  });

  it("removing needs a reason, is audited, frees the address, and the entry never changes again", async () => {
    const id = ((await find(owner, "050-7100003")).entries as Row[])[0].id as string;
    const remove = (who: U, reason: string | null) =>
      asUser(who.id, (q) => q("select public.consent_blocklist_remove($1, $2, $3)", [org, id, reason]));
    expect((await pgError(remove(member, "added_by_mistake"))).code).toBe("42501");
    expect((await pgError(remove(owner, null))).hint).toBe("consent_blocklist:removed_reason");
    await remove(admin, "added_by_mistake");
    expect((await pgError(remove(admin, "other"))).hint).toBe("consent_blocklist:gone");
    expect(await suppressed("sms", "050-7100003")).toBe(false);
    const audit = await asAdmin(
      async (q) =>
        (
          await q<{ entity_id: string; changes: Row }>(
            "select entity_id, changes from public.audit_log where organization_id = $1 and action = 'consent_blocklist_remove'",
            [org],
          )
        ).rows,
    );
    expect(audit).toEqual([{ entity_id: id, changes: { kind: "phone", channel: "sms", reason: "person_request", removed_reason: "added_by_mistake" } }]);
    expect((await pgError(asAdmin((q) => q("update public.consent_blocklist set removed_at = null, removed_reason = null where id = $1", [id])))).hint).toBe(
      "consent_blocklist:append_only",
    );
    expect((await pgError(asAdmin((q) => q("update public.consent_blocklist set channel = 'whatsapp' where id = $1", [id])))).hint).toBe(
      "consent_blocklist:append_only",
    );
    // listed again later: a new entry
    expect(await add(owner, "sms", ["050-7100003"], "complaint")).toEqual({ added: 1, existing: 0, invalid: [] });
    expect(await summary(admin)).toMatchObject({ active: 3, removed: 1 });
  });

  it("without the key the address waits, the lock holds by address (and fails closed), and the backfill hashes it", async () => {
    const lead = await insertLead(member.id, org, { full_name: "בלי מפתח", phone: "050-7100020", email: "nokey@example.test" });
    await setKey(null);
    try {
      expect(await add(owner, "email", ["NoKey@example.test"])).toEqual({ added: 1, existing: 0, invalid: [] });
      // the same address again is found by its stored value
      expect(await add(owner, "email", ["nokey@example.test"])).toEqual({ added: 0, existing: 1, invalid: [] });
      expect(await locked(lead, "email", "nokey@example.test")).toBe(true);
      // a hashed SMS entry exists (050-7100003) that cannot be compared: any SMS address is locked meanwhile
      expect(await locked(lead, "sms", "+972507100020")).toBe(true);
      expect(await locked(lead, "whatsapp", "+972507100020")).toBe(true); // the hashed 'all' phone entry
      expect(await suppressed("email", "nokey@example.test")).toBeNull();
      expect(await summary(owner)).toMatchObject({ key_present: false, waiting_hash: 1 });
      expect(await find(owner, "nokey@example.test")).toMatchObject({ checked: false });
      // a person's consent is refused without the key too (M2): the waiting entry by its address, any hashed entry fail closed
      expect((await pgError(manual(owner, lead, "email"))).hint).toBe("consent:blocklisted");
      expect((await pgError(manual(member, lead, "email"))).hint).toBe("consent:address_blocked");
      expect((await pgError(manual(admin, lead, "whatsapp"))).hint).toBe("consent:blocklisted");
    } finally {
      await setKey(KEY);
    }
    // with the key back but before the backfill, the waiting entry is still matched (hashed on the fly)
    expect(await suppressed("email", "nokey@example.test")).toBe(true);
    await asAdmin((q) => q("select app.consent_backfill_hashes()"));
    const row = await asAdmin(
      async (q) =>
        (
          await q<{ address_hash: string; value: string | null }>(
            `select b.address_hash, p.value from public.consent_blocklist b join app.consent_blocklist_pending p on p.entry_id = b.id
              where b.organization_id = $1`,
            [org],
          )
        ).rows,
    );
    expect(row).toEqual([{ address_hash: hmac(`${org}:email:nokey@example.test`), value: null }]);
    expect(await suppressed("email", "nokey@example.test")).toBe(true);
    expect(await locked(lead, "whatsapp", "+972507100020")).toBe(false);
  });

  it("a read-only business cannot change its list; bad input is refused with a hint", async () => {
    expect((await pgError(add(owner, "fax", ["050-7100030"]))).hint).toBe("consent_blocklist:channel");
    expect((await pgError(add(owner, "sms", ["050-7100030"], "because")))).toMatchObject({ hint: "consent_blocklist:reason" });
    expect((await pgError(add(owner, "sms", []))).hint).toBe("consent_blocklist:empty");
    expect((await pgError(add(owner, "sms", Array.from({ length: 501 }, (_, i) => `050-72${String(i).padStart(5, "0")}`)))).hint).toBe(
      "consent_blocklist:too_many",
    );
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(add(owner, "sms", ["050-7100030"]))).code).toBe("42501");
      // reading still works
      expect(await summary(owner)).toMatchObject({ active: 4 });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $2 where id = $1", [org, status]));
    }
  });
});
