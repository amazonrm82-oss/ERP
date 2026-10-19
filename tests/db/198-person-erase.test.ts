import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "pg";

import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, count, createOrg, createUser, insertLead, pgError, TEST_DB_URL, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Extra = Array<{ type: string; id: string }>;
type Preview = {
  people: { leads: Array<{ id: string; name: string | null; in_bin: boolean }>; contacts: Array<{ id: string; name: string | null; in_bin: boolean }> };
  matches: Array<{ type: string; id: string; via: string; shared: number; family: string; relatives: number; preselect: boolean; name: string | null }>;
  matches_truncated: boolean;
  counts: Record<string, number>;
  deals: Array<{ id: string; name: string; must_rename: boolean; suggested: string }>;
};
type Result = Record<string, number | boolean>;

/**
 * PRV-03 (owner's answer of 19 October 2026 with the lead's decisions): one call by an owner or admin in a second-step session,
 * with a reason, removes the person: the lead or contact, its conversion relatives and the ticked records of the same phone or
 * email (bin included), their further channels, files and form inquiries; meetings stay without the person's details; deals
 * and companies stay, a deal whose name holds the person's name renamed; consent hashes stay; one audit entry with the reason.
 */
describe("removing a person from everywhere (PRV-03)", () => {
  let owner: U, admin: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let form: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const convert = (lead: string) =>
    asUser(member.id, async (q) =>
      (await one<{ r: { contact_id: string; company_id: string; deal_id: string } }>(q, "select public.convert_lead($1, true, null, 100000) as r", [lead])).r,
    );
  const preview = (type: string, id: string, extra: Extra = [], u: U = admin) =>
    asMfaUser(u.id, async (q) => (await one<{ p: Preview }>(q, "select public.privacy_erase_preview($1, $2, $3, $4) as p", [org, type, id, JSON.stringify(extra)])).p);
  const erase = (type: string, id: string, opts: { extra?: Extra; reason?: string | null; names?: Record<string, string>; u?: U; org?: string } = {}) =>
    asMfaUser((opts.u ?? admin).id, async (q) =>
      (
        await one<{ r: Result }>(q, "select public.privacy_erase_person($1, $2, $3, $4, $5, $6, true) as r", [
          opts.org ?? org,
          type,
          id,
          JSON.stringify(opts.extra ?? []),
          opts.reason === undefined ? "הלקוח ביקש" : opts.reason,
          JSON.stringify(opts.names ?? {}),
        ])
      ).r,
    );
  const exists = (table: string, id: string) => asAdmin((q) => count(q, `select 1 from public.${table} where id = $1`, [id]));

  beforeAll(async () => {
    owner = await createUser("pe-owner");
    org = await createOrg(owner.id, "עסק הפרטיות");
    admin = await addMember(org, owner.id, "admin", "pe-admin");
    member = await addMember(org, owner.id, "member", "pe-member");
    outsider = await createUser("pe-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    form = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.forms (organization_id, name) values ($1, 'טופס') returning id", [org])).id);
  });

  it("takes the lead, its contact and every lead converted into it, bin included; keeps the deal renamed and the company", async () => {
    const lead = await insertLead(member.id, org, { full_name: "נועה לוי", phone: "052-1112233", email: "noa@private.example", company_name: "חברה בע\"מ" });
    const { contact_id: contact, company_id: company, deal_id: deal } = await convert(lead);
    const again = await insertLead(member.id, org, { full_name: "נועה שוב" });
    await asAdmin((q) => q("update public.leads set converted_contact_id = $2, converted_at = now(), deleted_at = now() where id = $1", [again, contact]));
    await asAdmin((q) => q("update public.deals set name = 'שיפוץ אצל נועה' where id = $1", [deal]));
    // what the person leaves around: a further phone, a file, a form inquiry, a meeting, a note
    await asUser(member.id, async (q) => {
      await q("insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'phone', '053-4445566')", [org, contact]);
      await q("insert into public.files (organization_id, contact_id, name, mime_type, size_bytes) values ($1, $2, 'תעודה.pdf', 'application/pdf', 1000)", [org, contact]);
      await q("insert into public.activities (organization_id, type, body, contact_id) values ($1, 'note', 'נועה התקשרה', $2)", [org, contact]);
    });
    const submission = await asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.form_submissions (organization_id, form_id, status, lead_id, payload) values ($1, $2, 'accepted', $3, '{\"name\": \"נועה\"}') returning id", [org, form, lead])).id,
    );
    const meeting = await asUser(member.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id, location, description, owner_id) values ($1, 'פגישה עם נועה', now() + interval '1 day', now() + interval '1 day 1 hour', $2, 'רחוב הבית של נועה 5', 'נועה רוצה מטבח', $3) returning id",
          [org, contact, member.id],
        )
      ).id,
    );

    const p = await preview("leads", lead);
    expect(p.people.leads.map((l) => l.id).sort()).toEqual([lead, again].sort());
    expect(p.people.leads.find((l) => l.id === again)?.in_bin).toBe(true);
    expect(p.people.contacts.map((c) => c.id)).toEqual([contact]);
    expect(p.counts).toMatchObject({ leads: 2, contacts: 1, channels: 1, files: 1, inquiries: 1, meetings: 1 });
    expect(p.deals).toEqual([{ id: deal, name: "שיפוץ אצל נועה", must_rename: true, suggested: "עסקה (לקוח נמחק)" }]);

    // the deal holds her name: it must be renamed, and not to a name that still holds it
    expect((await pgError(erase("leads", lead))).hint).toBe("person_erase:deal_name");
    expect((await pgError(erase("leads", lead, { names: { [deal]: "עוד שיפוץ לנועה" } }))).hint).toBe("person_erase:deal_name");
    expect((await pgError(erase("leads", lead, { reason: "  " , names: { [deal]: "עסקה (לקוח נמחק)" } }))).hint).toBe("person_erase:reason");
    expect(await exists("leads", lead)).toBe(1);

    const result = await erase("leads", lead, { reason: "בקשת מחיקה בטלפון", names: { [deal]: "עסקה (לקוח נמחק)" } });
    expect(result).toMatchObject({ leads: 2, contacts: 1, channels: 1, files: 1, inquiries: 1, meetings: 1, deals_renamed: 1, paused: false });
    expect([await exists("leads", lead), await exists("leads", again), await exists("contacts", contact), await exists("form_submissions", submission)]).toEqual([0, 0, 0, 0]);
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_channels where contact_id = $1", [contact]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.files where contact_id = $1", [contact]))).toBe(0);
    expect(await asAdmin(async (q) => one(q, "select name, contact_id from public.deals where id = $1", [deal]))).toEqual({ name: "עסקה (לקוח נמחק)", contact_id: null });
    expect(await exists("companies", company)).toBe(1);
    // the meeting stays without her
    expect(await asAdmin(async (q) => one(q, "select title, location, description, contact_id, owner_id from public.meetings where id = $1", [meeting]))).toEqual({
      title: "פגישה (לקוח נמחק)",
      location: null,
      description: null,
      contact_id: null,
      owner_id: member.id,
    });
    const meetingHistory = await asAdmin(async (q) => (await q<{ c: string }>("select changes::text as c from public.audit_log where entity_type = 'meetings' and entity_id = $1", [meeting])).rows.map((r) => r.c));
    expect(meetingHistory.filter((c) => c.includes("נועה"))).toEqual([]);
    // the audit trail keeps who and when but not her, and the action names its reason only
    for (const id of [lead, again, contact]) {
      const entries = await asAdmin(async (q) => (await q<{ c: string }>("select changes::text as c from public.audit_log where entity_id = $1", [id])).rows.map((r) => r.c));
      expect(entries.filter((c) => c.includes("נועה") || c.includes("noa@private")), id).toEqual([]);
    }
    const action = await asAdmin((q) =>
      one<{ actor_id: string; entity_id: string | null; changes: { reason: string; counts: Record<string, number> } }>(
        q,
        "select actor_id, entity_id, changes from public.audit_log where organization_id = $1 and action = 'person_erase' order by id desc limit 1",
        [org],
      ),
    );
    expect(action).toMatchObject({ actor_id: admin.id, entity_id: null, changes: { reason: "בקשת מחיקה בטלפון", counts: { leads: 2, contacts: 1 } } });
    expect(JSON.stringify(action)).not.toContain("נועה");
    // the opt-out stays (hashes only)
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where subject_id = $1 and source = 'erasure' and address_hash is not null", [lead]))).toBeGreaterThan(0);
  });

  it("offers the same phone or email; the ticked ones go with their own relatives, the unticked stay, anything else is refused", async () => {
    const lead = await insertLead(member.id, org, { full_name: "דנה כץ", phone: "054-7778899", email: "dana@private.example" });
    const samePhone = await insertLead(member.id, org, { full_name: "ד. כץ", phone: "+972547778899" });
    const sameEmail = await asUser(member.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'דנה', $2) returning id", [org, member.id])).id,
    );
    await asUser(member.id, (q) => q("insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'email', 'DANA@private.example')", [org, sameEmail]));
    const stranger = await insertLead(member.id, org, { full_name: "אחר", phone: "050-0000001" });

    const p = await preview("leads", lead);
    expect(p.matches.map((m) => [m.type, m.id, m.via]).sort()).toEqual(
      [
        ["contacts", sameEmail, "email"],
        ["leads", samePhone, "phone"],
      ].sort(),
    );
    expect(p.matches.every((m) => m.preselect && m.shared === 1 && m.relatives === 0)).toBe(true);
    const ticked = await preview("leads", lead, [{ type: "leads", id: samePhone }]);
    expect(ticked.counts).toMatchObject({ leads: 2, contacts: 0 });
    // a repeated item counts once; more than 200 are refused
    expect((await preview("leads", lead, [{ type: "leads", id: samePhone }, { type: "leads", id: samePhone }])).counts).toMatchObject({ leads: 2, contacts: 0 });
    const many = Array.from({ length: 201 }, () => ({ type: "leads", id: samePhone }));
    expect((await pgError(preview("leads", lead, many))).hint).toBe("person_erase:extra_max");
    expect((await pgError(erase("leads", lead, { extra: many }))).hint).toBe("person_erase:extra_max");
    expect((await pgError(preview("leads", lead, [{ type: "leads", id: stranger }]))).hint).toBe("person_erase:extra");
    expect((await pgError(erase("leads", lead, { extra: [{ type: "contacts", id: stranger }] }))).hint).toBe("person_erase:extra");

    expect(await erase("leads", lead, { extra: [{ type: "leads", id: samePhone }] })).toMatchObject({ leads: 2, contacts: 0 });
    expect([await exists("leads", lead), await exists("leads", samePhone), await exists("contacts", sameEmail), await exists("leads", stranger)]).toEqual([0, 0, 1, 1]);
  });

  it("suggests the accepted quote's number for a deal that holds the name", async () => {
    const lead = await insertLead(member.id, org, { full_name: "יוסי מזרחי" });
    const { contact_id: contact, deal_id: deal } = await convert(lead);
    await asAdmin((q) => q("update public.deals set name = 'יוסי - מטבח' where id = $1", [deal]));
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"quotes\": true}' where organization_id = $1", [org]));
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    const number = await asUser(member.id, async (q) => {
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'מטבח', $2, $3) returning id", [org, deal, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 100)", [org, quote]);
      const sent = await one<{ r: { number: string } }>(q, "select public.quote_send($1, $2) as r", [org, quote]);
      return { quote, number: sent.r.number };
    }).then(async (made) => {
      await asAdmin((a) => a("update public.quotes set status = 'accepted' where id = $1", [made.quote]));
      return made.number;
    });
    const quote = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.quotes where deal_id = $1 and status = 'accepted'", [deal])).id);
    await asAdmin((q) =>
      q(
        "insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, signer_id_number, signature_kind, signature_image, wording_version, content_sha256, ip, user_agent) values ($1, $2, 'accepted', 'יוסי מזרחי', '000000018', 'drawn', 'data:image/png;base64,AAAA', 'draft-1', repeat('a', 64), '10.1.2.3', 'Mozilla יוסי')",
        [org, quote],
      ),
    );
    // a company customer would carry the contact's name too
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set customer_contact_name = 'יוסי מזרחי' where id = $1", [quote]);
    });
    expect(await asAdmin(async (q) => one(q, "select customer_name, customer_contact_name from public.quotes where id = $1", [quote]))).toEqual({
      customer_name: "יוסי מזרחי",
      customer_contact_name: "יוסי מזרחי",
    });
    const p = await preview("contacts", contact);
    expect(p.deals).toEqual([{ id: deal, name: "יוסי - מטבח", must_rename: true, suggested: `עסקה ${number}` }]);
    expect(await erase("contacts", contact, { names: { [deal]: `עסקה ${number}` } })).toMatchObject({ deals_renamed: 1 });
    // the accepted quote stays on the kept deal, without the customer's name or the signer's details
    expect(await asAdmin(async (q) => one(q, "select deal_id, customer_name, customer_contact_name from public.quotes where id = $1", [quote]))).toEqual({
      deal_id: deal,
      customer_name: null,
      customer_contact_name: null,
    });
    expect(
      await asAdmin(async (q) =>
        one(q, "select signer_name, signer_id_number, signature_image, ip, user_agent, erased_at is not null as erased from public.quote_decisions where quote_id = $1", [quote]),
      ),
    ).toEqual({ signer_name: null, signer_id_number: null, signature_image: null, ip: null, user_agent: null, erased: true });
    // a deal name that does not hold the name may stay as it is
    const other = await insertLead(member.id, org, { full_name: "רונית" });
    const { deal_id: otherDeal } = await convert(other);
    await asAdmin((q) => q("update public.deals set name = 'פרויקט גינה' where id = $1", [otherDeal]));
    expect((await preview("leads", other)).deals).toEqual([{ id: otherDeal, name: "פרויקט גינה", must_rename: false, suggested: "עסקה (לקוח נמחק)" }]);
    expect(await erase("leads", other)).toMatchObject({ deals_renamed: 0 });
    expect(await asAdmin(async (q) => (await one<{ n: string }>(q, "select name as n from public.deals where id = $1", [otherDeal])).n)).toBe("פרויקט גינה");
    // a name for a deal that does not stay is refused
    const third = await insertLead(member.id, org, { full_name: "שלישי" });
    expect((await pgError(erase("leads", third, { names: { [otherDeal]: "x" } }))).hint).toBe("person_erase:deal_name");
  });

  it("only owners and admins, in a writable business, in a second-step session; helpers are no one's", async () => {
    const lead = await insertLead(member.id, org, { full_name: "מוגן" });
    expect((await pgError(erase("leads", lead, { u: member }))).code).toBe("42501");
    expect((await pgError(preview("leads", lead, [], member))).code).toBe("42501");
    expect((await pgError(erase("leads", lead, { u: outsider }))).code).toBe("42501");
    expect((await pgError(erase("leads", lead, { u: outsider, org: otherOrg }))).code).toBe("P0002");
    const plain = await pgError(
      asUser(admin.id, (q) => q("select public.privacy_erase_person($1, 'leads', $2, '[]'::jsonb, 'סיבה')", [org, lead])),
    );
    expect(plain.hint).toBe("mfa:self_first");
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(erase("leads", lead, { u: owner }))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    expect((await pgError(erase("deals", lead, { u: owner }))).code).toBe("22023");
    expect(await exists("leads", lead)).toBe(1);
    for (const [fn, role, expected] of [
      ["public.privacy_erase_person(uuid, text, uuid, jsonb, text, jsonb, boolean)", "anon", false],
      ["public.privacy_erase_person(uuid, text, uuid, jsonb, text, jsonb, boolean)", "authenticated", true],
      ["public.privacy_erase_preview(uuid, text, uuid, jsonb)", "anon", false],
      ["public.privacy_erase_preview(uuid, text, uuid, jsonb)", "authenticated", true],
      ["app.person_erase_set(uuid, text, uuid)", "authenticated", false],
      ["app.person_erase_full(uuid, text, uuid, jsonb)", "authenticated", false],
      ["app.person_erase_matches(uuid, uuid[], uuid[])", "authenticated", false],
      ["app.person_erase_kept_deals(uuid, uuid[], uuid[])", "authenticated", false],
      ["app.person_erase_allowed(uuid)", "authenticated", false],
      // the one helper that deletes rows (the owner's paste file): no role runs it, only privacy_erase_person
      ["app.person_erase_delete_rows(uuid, uuid[], uuid[])", "anon", false],
      ["app.person_erase_delete_rows(uuid, uuid[], uuid[])", "authenticated", false],
      ["app.person_erase_delete_rows(uuid, uuid[], uuid[])", "service_role", false],
    ] as const) {
      expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as c", [role, fn])).c), `${fn} ${role}`).toBe(expected);
    }
    expect((await pgError(asAnon((q) => q("select public.privacy_erase_person($1, 'leads', $2, '[]'::jsonb, 'x')", [org, lead])))).code).toBe("42501");
  });

  it("a record linked to the person while the removal waits for its locks makes it refuse, to be tried again", async () => {
    const lead = await insertLead(member.id, org, { full_name: "מירוץ" });
    const { contact_id: contact } = await convert(lead);
    await asAdmin((q) => q("update public.deals set name = 'עסקה' where id = (select converted_deal_id from public.leads where id = $1)", [lead]));
    const holder = new Client({ connectionString: TEST_DB_URL });
    const remover = new Client({ connectionString: TEST_DB_URL });
    await holder.connect();
    await remover.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from public.contacts where id = $1 for update", [contact]);
      await remover.query("begin");
      await remover.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner.id, role: "authenticated", aal: "aal2" })]);
      await remover.query("set local role authenticated");
      const removal = remover.query("select public.privacy_erase_person($1, 'leads', $2, '[]'::jsonb, 'סיבה')", [org, lead]).then(
        () => null,
        (err: { code?: string; hint?: string }) => err,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const late = await insertLead(member.id, org, { full_name: "מירוץ שוב" });
      await holder.query("update public.leads set converted_contact_id = $2, converted_at = now() where id = $1", [late, contact]);
      await holder.query("commit");
      const err = await removal;
      await remover.query("rollback");
      expect(err).toMatchObject({ code: "40001", hint: "person_erase:changed" });
    } finally {
      await holder.end();
      await remover.end();
    }
    expect([await exists("leads", lead), await exists("contacts", contact)]).toEqual([1, 1]);
  });

  it("all or nothing: a failure on the way leaves every record, meeting and inquiry in place", async () => {
    const lead = await insertLead(member.id, org, { full_name: "חצי דרך" });
    const { contact_id: contact } = await convert(lead);
    await asAdmin((q) => q("update public.deals set name = 'עסקה ניטרלית' where id = (select converted_deal_id from public.leads where id = $1)", [lead]));
    const meeting = await asUser(member.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id) values ($1, 'פגישה עם חצי', now() + interval '1 day', now() + interval '1 day 1 hour', $2) returning id", [org, lead])).id,
    );
    await asAdmin(async (q) => {
      await q("create schema if not exists prv03_test");
      await q("create or replace function prv03_test.refuse() returns trigger language plpgsql as $$ begin raise exception 'refused' using errcode = 'P0001'; end $$");
      await q("create trigger prv03_refuse before delete on public.contacts for each row execute function prv03_test.refuse()");
    });
    try {
      expect((await pgError(erase("leads", lead, { u: owner }))).message).toContain("refused");
    } finally {
      await asAdmin(async (q) => {
        await q("drop trigger if exists prv03_refuse on public.contacts");
        await q("drop schema if exists prv03_test cascade");
      });
    }
    expect([await exists("leads", lead), await exists("contacts", contact)]).toEqual([1, 1]);
    expect(await asAdmin(async (q) => (await one<{ t: string }>(q, "select title as t from public.meetings where id = $1", [meeting])).t)).toBe("פגישה עם חצי");
  });

  it("without the consent key the records still go, and the erasure waits for the key", async () => {
    const lead = await insertLead(member.id, org, { full_name: "מחכה למפתח", phone: "052-9998877" });
    // the key is emptied inside this one transaction only, so database tests running beside this one never see it missing
    const client = new Client({ connectionString: TEST_DB_URL });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("update app.settings set value = '' where key = 'consent_hash_key'");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner.id, role: "authenticated", aal: "aal2" })]);
      await client.query("set local role authenticated");
      const result = (await client.query<{ r: Result }>("select public.privacy_erase_person($1, 'leads', $2, '[]'::jsonb, 'סיבה') as r", [org, lead])).rows[0].r;
      expect(result).toMatchObject({ leads: 1, contacts: 0, paused: true });
      await client.query("reset role");
      expect((await client.query("select 1 from public.leads where id = $1", [lead])).rowCount).toBe(0);
      expect((await client.query("select 1 from app.pending_erasures where record_id = $1 and completed_at is null", [lead])).rowCount).toBe(1);
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
    expect(await asAdmin(async (q) => (await one<{ v: string }>(q, "select value as v from app.settings where key = 'consent_hash_key'")).v)).not.toBe("");
  });

  it("notifications about the person's meetings lose the name too", async () => {
    const lead = await insertLead(member.id, org, { full_name: "שירה ברק" });
    const { contact_id: contact } = await convert(lead);
    await asAdmin((q) => q("update public.deals set name = 'עסקה' where id = (select converted_deal_id from public.leads where id = $1)", [lead]));
    // booked by the owner for the member: the member is told, with the title
    const meeting = await asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id, owner_id) values ($1, 'ייעוץ: שירה ברק', now() + interval '2 days', now() + interval '2 days 1 hour', $2, $3) returning id",
          [org, contact, member.id],
        )
      ).id,
    );
    const notices = () =>
      asAdmin(async (q) => (await q<{ title: string; body: string | null }>("select title, body from public.notifications where entity_type = 'meeting' and entity_id = $1", [meeting])).rows);
    const before = await notices();
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((n) => n.title.includes("שירה"))).toBe(true);
    await erase("leads", lead);
    const after = await notices();
    expect(after.length).toBe(before.length);
    expect(after.every((n) => n.title === "פגישה (לקוח נמחק)" && n.body === null)).toBe(true);
  });

  it("does not preselect a match whose address many records share, or one that brings unoffered relatives", async () => {
    const lead = await insertLead(member.id, org, { full_name: "משרד ראשי", phone: "03-5556677", email: "boss@private.example" });
    const office = await Promise.all([1, 2, 3].map((n) => insertLead(member.id, org, { full_name: `עובד ${n}`, phone: "035556677" })));
    // the same email, on a lead that was converted into a contact with nothing in common
    const family = await insertLead(member.id, org, { full_name: "בוס", email: "Boss@private.example" });
    const { contact_id: familyContact } = await convert(family);
    await asAdmin((q) => q("update public.contacts set email = null, phone = null where id = $1", [familyContact]));
    const p = await preview("leads", lead);
    const byId = new Map(p.matches.map((m) => [m.id, m]));
    for (const id of office) expect(byId.get(id)).toMatchObject({ via: "phone", shared: 3, relatives: 0, preselect: false });
    expect(byId.get(family)).toMatchObject({ via: "email", shared: 1, relatives: 1, preselect: false });
    expect(byId.has(familyContact)).toBe(false);
    // still offered: ticking one takes it with its relatives
    expect((await preview("leads", lead, [{ type: "leads", id: family }])).counts).toMatchObject({ leads: 2, contacts: 1 });
    // each office lead is its own family; the converted lead's family is keyed by its set
    expect(new Set(office.map((id) => byId.get(id)!.family)).size).toBe(3);
    expect(byId.get(family)!.family).toBe([family, familyContact].sort()[0]);
  });

  it("a conversion family of matches is offered as one, preselected when all of it is", async () => {
    const lead = await insertLead(member.id, org, { full_name: "אורית שמש", phone: "054-3332211" });
    const twin = await insertLead(member.id, org, { full_name: "אורית ש.", phone: "054-3332211" });
    const { contact_id: twinContact } = await convert(twin);
    const p = await preview("leads", lead);
    const mine = p.matches.filter((m) => m.id === twin || m.id === twinContact);
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((m) => m.family)).size).toBe(1);
    expect(mine.every((m) => m.preselect && m.relatives === 0)).toBe(true);
  });

  it("offers at most 200 matches and says there are more, without reading the matches once per match", async () => {
    const lead = await insertLead(member.id, org, { full_name: "מרכזייה", phone: "03-7000000" });
    const status = await asAdmin(async (q) => (await one<{ s: string }>(q, "select status_id as s from public.leads where id = $1", [lead])).s);
    await asAdmin((q) =>
      q(
        "insert into public.leads (organization_id, status_id, full_name, phone, owner_id) select $1, $2, 'שלוחה ' || g, '037000000', $3 from generate_series(1, 300) g",
        [org, status, member.id],
      ),
    );
    // one transaction with function tracking on, so the calls of this preview alone are counted
    const client = new Client({ connectionString: TEST_DB_URL });
    await client.connect();
    let p: Preview;
    let calls: Record<string, number>;
    const started = Date.now();
    try {
      await client.query("begin");
      await client.query("set local track_functions = 'all'");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin.id, role: "authenticated", aal: "aal2" })]);
      await client.query("set local role authenticated");
      p = (await client.query<{ p: Preview }>("select public.privacy_erase_preview($1, 'leads', $2, '[]'::jsonb) as p", [org, lead])).rows[0].p;
      // and again with all 200 ticked: each ticked record is checked against the offer read once, not by reading it again
      const all = p.matches.map((m) => ({ type: m.type, id: m.id }));
      const ticked = (await client.query<{ p: Preview }>("select public.privacy_erase_preview($1, 'leads', $2, $3) as p", [org, lead, JSON.stringify(all)])).rows[0].p;
      expect(ticked.counts).toMatchObject({ leads: 201 });
      await client.query("reset role");
      const rows = (await client.query<{ f: string; n: string }>(
        "select funcname as f, calls::text as n from pg_stat_xact_user_functions where schemaname = 'app' and funcname in ('person_erase_matches', 'person_erase_set')",
      )).rows;
      calls = Object.fromEntries(rows.map((r) => [r.f, Number(r.n)]));
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
    const took = Date.now() - started;
    expect(p.matches).toHaveLength(200);
    expect(p.matches_truncated).toBe(true);
    expect(p.matches.every((m) => m.shared === 300 && !m.preselect)).toBe(true);
    // over both previews the matches are read a fixed number of times, not once per match or per ticked record; the
    // conversion family once per offered or ticked record
    expect(calls.person_erase_matches).toBeLessThanOrEqual(6);
    expect(calls.person_erase_set).toBeLessThanOrEqual(610);
    expect(took).toBeLessThan(15000);
  });

  it("a single word of the name needs three letters to require a new deal name; a full name of two is enough", async () => {
    const lead = await insertLead(member.id, org, { full_name: "אל כהנא" });
    const { deal_id: deal } = await convert(lead);
    await asAdmin((q) => q("update public.deals set name = 'אלון גינות' where id = $1", [deal]));
    expect((await preview("leads", lead)).deals).toMatchObject([{ id: deal, must_rename: false }]);
    await asAdmin((q) => q("update public.deals set name = 'גינה לכהנא' where id = $1", [deal]));
    expect((await preview("leads", lead)).deals).toMatchObject([{ id: deal, must_rename: true }]);
    const short = await insertLead(member.id, org, { full_name: "בן" });
    const { deal_id: shortDeal } = await convert(short);
    await asAdmin((q) => q("update public.deals set name = 'בנייה' where id = $1", [shortDeal]));
    expect((await preview("leads", short)).deals).toMatchObject([{ id: shortDeal, must_rename: true }]);
  });
});
