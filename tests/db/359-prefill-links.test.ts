import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, defaultLeadStatus, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Field = { key: string; label: string; type: string; options: unknown[]; help: string | null; required: boolean; read_only: boolean; value: unknown };
type Page = {
  status?: string;
  rate_limited?: boolean;
  business?: string;
  brand?: { logo: string | null; color: string | null };
  built_with?: boolean;
  title?: string;
  intro?: string | null;
  notice?: { name: string; email: string | null; phone: string | null };
  fields?: Field[];
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const sender = (n: number) => sha256(`prefill-sender-${n}`);

/**
 * BIZ-05: a form that fills an EXISTING lead or contact, sent by a personal link. Templates are a managed list (owners/admins,
 * plan key prefill_links, never a sensitive field); a link is made by whoever may edit the record; only the token's SHA-256 is
 * kept. The page (public.prefill_public, service_role only) answers only the business's display fields, the template's title
 * and the template's fields with the record's current values; the submit writes only those fields, once, as the server.
 */
describe("prefill links (BIZ-05)", () => {
  let owner: U, admin: U, manager: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const contact = (ownerId: string, orgId = org) =>
    asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, last_name, email, phone, owner_id, job_title) values ($1, 'דנה', 'כהן', 'dana@example.com', '050-7654321', $2, 'סודי') returning id", [orgId, ownerId])).id,
    );
  const lead = async (ownerId: string, orgId = org) => {
    const status = await defaultLeadStatus(orgId);
    return asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.leads (organization_id, status_id, full_name, owner_id, phone) values ($1, $2, 'רון לוי', $3, '050-1112233') returning id", [orgId, status, ownerId])).id,
    );
  };
  const field = (key: string, type: string, extra: Record<string, unknown> = {}, orgId = org, object = "contact") =>
    asAdmin((q) =>
      q(
        `insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, is_required, is_read_only, is_unique, privacy_class)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [orgId, object, key, `שדה ${key}`, type, JSON.stringify(extra.options ?? []), extra.required ?? false, extra.readOnly ?? false, extra.unique ?? false, extra.privacy ?? null],
      ),
    );
  const template = (u: U, fields: string[], recordType = "contact", orgId = org) =>
    asUser(u.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.prefill_forms (organization_id, name, record_type, title, intro, fields) values ($1, 'שאלון', $2, 'כמה פרטים', 'נשמח לעזרה', $3) returning id", [orgId, recordType, fields])).id,
    );
  const create = (u: U, form: string, type: string, id: string, orgId = org) =>
    asUser(u.id, async (q) => (await one<{ t: string }>(q, "select public.prefill_link_create($1, $2, $3, $4) as t", [orgId, form, type, id])).t);
  const page = (token: string, ip: string | null = sender(++n)) =>
    asService(async (q) => (await one<{ r: Page }>(q, "select public.prefill_public($1, $2) as r", [token, ip])).r);
  const submit = (token: string, values: unknown, ip: string | null = sender(++n)) =>
    asService(async (q) => (await one<{ r: { status?: string; skipped?: string[]; rate_limited?: boolean; reason?: string; error?: string } }>(q, "select public.prefill_public_submit($1, $2, $3) as r", [token, ip, JSON.stringify(values)])).r);
  const contactRow = (id: string) =>
    asAdmin(async (q) => one<Record<string, unknown>>(q, "select * from public.contacts where id = $1", [id]));

  beforeAll(async () => {
    owner = await createUser("pf-owner");
    org = await createOrg(owner.id, "עסק המילוי");
    admin = await addMember(org, owner.id, "admin", "pf-admin");
    manager = await addMember(org, owner.id, "manager", "pf-manager");
    member = await addMember(org, owner.id, "member", "pf-member");
    other = await addMember(org, owner.id, "member", "pf-other");
    viewer = await addMember(org, owner.id, "viewer", "pf-viewer");
    outsider = await createUser("pf-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asAdmin((q) => q("update public.organizations set brand_color = '#336699' where id = $1", [org]));
    await field("diet", "select", { options: ["רגיל", "צמחוני"], required: true });
    await field("code", "text", { readOnly: true });
    await field("member_no", "text", { unique: true });
    await field("allergy", "text", { privacy: "sensitive" });
    await field("doc", "file");
  });

  it("every business gets one DRAFT default; a person cannot set the server-only columns", async () => {
    const rows = await asUser(member.id, async (q) =>
      (await q<{ name: string; record_type: string; fields: string[]; key: string; draft_wording: boolean; id: string }>("select id, name, record_type, fields, key, draft_wording from public.prefill_forms where organization_id = $1", [org])).rows,
    );
    expect(rows).toEqual([{ id: expect.any(String), name: "פרטים לפני הפגישה", record_type: "contact", fields: ["first_name", "last_name", "email", "phone"], key: "before_meeting", draft_wording: true }]);
    // a person's change of the wording clears the draft mark; the record type never changes
    await asUser(admin.id, (q) => q("update public.prefill_forms set title = 'פרטים לפגישה' where id = $1", [rows[0].id]));
    const after = await asAdmin(async (q) => one<{ draft_wording: boolean; key: string }>(q, "select draft_wording, key from public.prefill_forms where id = $1", [rows[0].id]));
    expect(after).toEqual({ draft_wording: false, key: "before_meeting" });
    expect((await pgError(asUser(admin.id, (q) => q("update public.prefill_forms set record_type = 'lead' where id = $1", [rows[0].id])))).code).toBe("42501");
    expect((await pgError(asUser(admin.id, (q) => q("update public.prefill_forms set key = null where id = $1", [rows[0].id])))).code).toBe("42501");
  });

  it("templates: owners/admins only, known fields only, never a sensitive one; the plan key", async () => {
    expect(await template(admin, ["first_name", "cf:diet"])).toMatch(UUID);
    for (const u of [manager, member, viewer, outsider]) {
      expect((await pgError(template(u, ["email"]))).code, u.email).toBe("42501");
    }
    expect((await pgError(template(admin, ["salary"]))).hint).toBe("prefill_form:field");
    expect((await pgError(template(admin, ["email", "email"]))).hint).toBe("prefill_form:field");
    expect((await pgError(template(admin, ["full_name"]))).hint).toBe("prefill_form:field"); // a lead's field on a contact template
    expect((await pgError(template(admin, ["cf:doc"]))).hint).toBe("prefill_form:field"); // a file field is never on a public form
    expect((await pgError(template(admin, ["cf:nope"]))).hint).toBe("prefill_form:field");
    expect((await pgError(template(admin, ["cf:allergy"]))).hint).toBe("prefill_form:sensitive");
    expect((await pgError(template(admin, []))).code).toBeDefined();
    // another business's field is unknown here
    await field("theirs", "text", {}, otherOrg);
    expect((await pgError(template(admin, ["cf:theirs"]))).hint).toBe("prefill_form:field");
    expect(await template(admin, ["full_name"], "lead")).toMatch(UUID);

    const id = await template(admin, ["email"]);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"prefill_links\": false}' where organization_id = $1", [org]));
    try {
      expect((await pgError(template(admin, ["email"]))).hint).toBe("feature:prefill_links");
      expect((await pgError(asUser(admin.id, (q) => q("update public.prefill_forms set title = 'x' where id = $1", [id])))).hint).toBe("feature:prefill_links");
      // switching off and removing stay allowed
      expect((await asUser(admin.id, (q) => q("update public.prefill_forms set is_active = false where id = $1", [id]))).rowCount).toBe(1);
      expect((await asUser(admin.id, (q) => q("delete from public.prefill_forms where id = $1", [id]))).rowCount).toBe(1);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{}' where organization_id = $1", [org]));
    }
  });

  it("a link is made by whoever may edit the record; only the token's hash is kept; the API cannot reach the page functions", async () => {
    const form = await template(admin, ["first_name", "email", "cf:diet"]);
    const c = await contact(member.id);
    const token = await create(member, form, "contact", c);
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const stored = await asAdmin(async (q) => (await q<Record<string, unknown>>("select * from app.prefill_links where token_hash = $1", [sha256(token)])).rows);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);
    const audit = await asAdmin(async (q) => (await q<{ changes: unknown }>("select changes from public.audit_log where action = 'prefill_link' and entity_id = $1", [c])).rows);
    expect(audit).toEqual([{ changes: { link: "created", form } }]);

    expect((await pgError(create(viewer, form, "contact", c))).code).toBe("42501");
    expect((await pgError(create(outsider, form, "contact", c))).code).toBe("42501");
    expect((await pgError(create(outsider, form, "contact", c, otherOrg))).code).toBe("42501");
    // a member who reads but may not edit another's contact
    const others = await contact(other.id);
    expect((await pgError(create(member, form, "contact", others))).code).toBe("42501");
    // a template of another record type, or of another business
    const leadForm = await template(admin, ["full_name"], "lead");
    expect((await pgError(create(member, leadForm, "contact", c))).hint).toBe("prefill_link:form");
    const theirForm = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.prefill_forms where organization_id = $1 limit 1", [otherOrg])).id);
    expect((await pgError(create(member, theirForm, "contact", c))).hint).toBe("prefill_link:form");
    // a record of another business
    const theirContact = await contact(outsider.id, otherOrg);
    expect((await pgError(create(member, form, "contact", theirContact))).code).toBe("42501");

    for (const sql of ["select public.prefill_public($1, null)", "select public.prefill_public_submit($1, null, '{}')"]) {
      expect((await pgError(asUser(owner.id, (q) => q(sql, [token])))).code).toBe("42501");
      expect((await pgError(asAnon((q) => q(sql, [token])))).code).toBe("42501");
    }
    expect((await pgError(asUser(owner.id, (q) => q("select * from app.prefill_links")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.prefill_link_create($1, $2, 'contact', $3)", [org, form, c])))).code).toBe("42501");
  });

  it("the page answers only the business's display fields and the template's fields with current values", async () => {
    const form = await template(admin, ["first_name", "email", "cf:diet", "cf:code"]);
    const c = await contact(member.id);
    await asAdmin((q) => q("update public.contacts set custom_fields = '{\"code\": \"A1\", \"allergy\": \"secret\"}' where id = $1", [c]));
    const token = await create(member, form, "contact", c);
    const answer = await page(token);
    expect(answer).toEqual({
      status: "open",
      business: "עסק המילוי",
      brand: { logo: null, color: "#336699" },
      built_with: expect.any(Boolean),
      title: "כמה פרטים",
      intro: "נשמח לעזרה",
      notice: { name: "עסק המילוי", email: null, phone: null },
      fields: [
        { key: "first_name", label: "שם פרטי", type: "text", options: [], help: null, required: false, read_only: false, value: "דנה" },
        // a stored email is shown, not asked
        { key: "email", label: "אימייל", type: "email", options: [], help: null, required: false, read_only: true, value: "dana@example.com" },
        { key: "cf:diet", label: "שדה diet", type: "select", options: ["רגיל", "צמחוני"], help: null, required: true, read_only: false, value: null },
        { key: "cf:code", label: "שדה code", type: "text", options: [], help: null, required: false, read_only: true, value: "A1" },
      ],
    });
    const text = JSON.stringify(answer);
    expect(text).not.toMatch(UUID);
    // nothing of the record beyond the template's fields
    for (const leaked of ["כהן", "050", "סודי", "secret"]) expect(text).not.toContain(leaked);

    // a field marked sensitive later is left out of the page and refused on submit
    await asAdmin((q) => q("update public.field_definitions set privacy_class = 'sensitive' where organization_id = $1 and key = 'diet'", [org]));
    try {
      expect((await page(token)).fields?.map((f) => f.key)).toEqual(["first_name", "email", "cf:code"]);
      expect((await submit(token, { "cf:diet": "רגיל" })).status).toBe("invalid");
    } finally {
      await asAdmin((q) => q("update public.field_definitions set privacy_class = null where organization_id = $1 and key = 'diet'", [org]));
    }

    // not found: unknown token, revoked, expired, record binned, template off, no key, closed pages
    expect((await pgError(page("x".repeat(64)))).code).toBe("P0002");
    const binned = await create(member, form, "contact", await contact(member.id));
    await asAdmin((q) => q("update public.contacts set deleted_at = now() where id = (select contact_id from app.prefill_links where token_hash = $1)", [sha256(binned)]));
    expect((await pgError(page(binned))).code).toBe("P0002");
    const expired = await create(member, form, "contact", c);
    await asAdmin((q) => q("update app.prefill_links set expires_at = now() - interval '1 minute' where token_hash = $1", [sha256(expired)]));
    expect((await pgError(page(expired))).code).toBe("P0002");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"prefill_links\": false}' where organization_id = $1", [org]));
    try {
      expect((await pgError(page(token))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{}' where organization_id = $1", [org]));
    }
    await asAdmin((q) => q("update public.prefill_forms set is_active = false where id = $1", [form]));
    expect((await pgError(page(token))).code).toBe("P0002");
    await asAdmin((q) => q("update public.prefill_forms set is_active = true where id = $1", [form]));
    expect((await page(token)).status).toBe("open");
  });

  it("revoke and the record's list: no token, state per link; who may revoke", async () => {
    const form = await template(admin, ["email"]);
    const c = await contact(member.id);
    const token = await create(member, form, "contact", c);
    const list = (u: U) => asUser(u.id, async (q) => (await one<{ r: Array<Record<string, unknown>> }>(q, "select public.prefill_links_for_record($1, 'contact', $2) as r", [org, c])).r);
    const rows = await list(member);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ form_name: "שאלון", state: "open", can_revoke: true, created_by: member.id });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(await list(outsider)).toEqual([]);
    expect((await list(viewer))[0]).toMatchObject({ can_revoke: false });
    const linkId = rows[0].id as string;
    expect((await pgError(asUser(viewer.id, (q) => q("select public.prefill_link_revoke($1, $2)", [org, linkId])))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("select public.prefill_link_revoke($1, $2)", [otherOrg, linkId])))).code).toBe("42501");
    expect(await asUser(admin.id, async (q) => (await one<{ r: boolean }>(q, "select public.prefill_link_revoke($1, $2) as r", [org, linkId])).r)).toBe(true);
    expect((await list(member))[0]).toMatchObject({ state: "revoked", can_revoke: false });
    expect((await pgError(page(token))).code).toBe("P0002");
  });

  it("the submit writes only the template's fields, once, as the server; a timeline entry and a notice", async () => {
    const form = await template(admin, ["first_name", "email", "phone", "birth_date", "cf:diet", "cf:code", "cf:member_no"]);
    const c = await contact(member.id);
    await asAdmin((q) => q("update public.contacts set custom_fields = '{\"code\": \"A1\"}' where id = $1", [c]));
    const holder = await contact(member.id);
    await asAdmin((q) => q("update public.contacts set custom_fields = '{\"member_no\": \"777\"}' where id = $1", [holder]));
    // the email is filled by the form only while the record holds none
    await asAdmin((q) => q("update public.contacts set email = null where id = $1", [c]));
    const token = await create(member, form, "contact", c);

    // unknown keys, a field not on the template, bad values, a missing required field
    expect(await submit(token, { job_title: "x" })).toEqual({ status: "invalid", error: "unknown field: job_title" });
    expect(await submit(token, { "cf:diet": "בשרי" })).toEqual({ status: "invalid", error: "invalid custom field: diet" });
    expect(await submit(token, { email: "not-an-email", "cf:diet": "רגיל" })).toEqual({ status: "invalid", error: "invalid email address" });
    expect(await submit(token, { birth_date: "2999-01-01", "cf:diet": "רגיל" })).toEqual({ status: "invalid", error: "invalid birth date" });
    expect(await submit(token, { first_name: "דנה" })).toEqual({ status: "invalid", error: "required field missing: cf:diet" });

    const before = await contactRow(c);
    const answer = await submit(token, {
      first_name: "  דניאלה ",
      email: "New@Example.com",
      // a stored phone is never replaced by the form: kept, reported as skipped
      phone: "052-1234567",
      birth_date: "1990-05-04",
      "cf:diet": "צמחוני",
      "cf:code": "B2",
      "cf:member_no": "777",
    });
    expect(answer).toEqual({ status: "saved", skipped: ["טלפון", "שדה code", "שדה member_no"] });
    const after = await contactRow(c);
    expect(after.first_name).toBe("דניאלה");
    // an empty email was filled; fields off the template are untouched
    expect(after.email).toBe("new@example.com");
    expect(after.last_name).toBe("כהן");
    expect(after.job_title).toBe("סודי");
    expect(after.phone).toBe("050-7654321");
    expect(String(after.birth_date)).toContain("1990");
    expect(after.custom_fields).toEqual({ code: "A1", diet: "צמחוני" });
    expect(after.owner_id).toBe(before.owner_id);
    // the audit entry has no actor (the customer, through the server)
    const audit = await asAdmin(async (q) => (await q<{ actor_id: string | null }>("select actor_id from public.audit_log where entity_id = $1 and action = 'update' order by created_at desc limit 1", [c])).rows);
    expect(audit[0]?.actor_id ?? null).toBeNull();
    // the timeline: labels only, no values, no author
    const entries = await asAdmin(async (q) => (await q<{ body: string; created_by: string | null; metadata: Record<string, unknown> }>("select body, created_by, metadata from public.activities where contact_id = $1 and metadata ->> 'kind' = 'prefill_submitted'", [c])).rows);
    expect(entries).toHaveLength(1);
    expect(entries[0].created_by).toBeNull();
    expect(entries[0].metadata).toMatchObject({ form_name: "שאלון", changed: ["שם פרטי", "אימייל", "תאריך לידה", "שדה diet"], skipped: ["טלפון", "שדה code", "שדה member_no"] });
    for (const value of ["דניאלה", "052", "new@", "1990", "צמחוני", "B2", "777"]) expect(JSON.stringify(entries[0])).not.toContain(value);
    // the notice goes to the maker (an active member who reads the record)
    const notices = await asAdmin(async (q) => (await q<{ user_id: string; body: string; entity_type: string }>("select user_id, body, entity_type from public.notifications where entity_id = $1 and title = 'הלקוח מילא טופס השלמת פרטים'", [c])).rows);
    expect(notices).toEqual([{ user_id: member.id, body: "שאלון", entity_type: "contact" }]);

    // once: the link now answers only "done", with nothing of the record
    expect(await submit(token, { first_name: "שוב" })).toEqual({ status: "done" });
    const done = await page(token);
    expect(done).toEqual({ status: "done", business: "עסק המילוי", brand: { logo: null, color: "#336699" }, built_with: expect.any(Boolean) });
    expect((await contactRow(c)).first_name).toBe("דניאלה");
  });

  it("a person never writes, changes or deletes the submission entry", async () => {
    const c = await contact(member.id);
    const form = await template(admin, ["first_name"]);
    await submit(await create(member, form, "contact", c), { first_name: "נועה" });
    const entry = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.activities where contact_id = $1 and metadata ->> 'kind' = 'prefill_submitted'", [c])).id);
    for (const sql of [
      "update public.activities set body = 'x' where id = $1",
      "delete from public.activities where id = $1",
    ]) {
      expect((await pgError(asUser(owner.id, (q) => q(sql, [entry])))).hint).toBe("activity:prefill_entry");
    }
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, contact_id, body, metadata) values ($1, 'note', $2, 'x', '{\"kind\": \"prefill_submitted\"}')", [org, c])))).hint,
    ).toBe("activity:prefill_entry");
  });

  it("notice routing: the record's owner when the maker left, else the owners and admins", async () => {
    const form = await template(admin, ["first_name"]);
    const leaver = await addMember(org, owner.id, "member", "pf-leaver");
    const c = await contact(other.id);
    await asAdmin((q) => q("update public.contacts set owner_id = $2 where id = $1", [c, leaver.id]));
    const token = await create(leaver, form, "contact", c);
    await asAdmin((q) => q("update public.contacts set owner_id = $2 where id = $1", [c, other.id]));
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, leaver.id]));
    await submit(token, { first_name: "א" });
    const to = async (id: string) =>
      (await asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.notifications where entity_id = $1 and title = 'הלקוח מילא טופס השלמת פרטים' order by user_id", [id])).rows)).map((r) => r.user_id);
    expect(await to(c)).toEqual([other.id]);

    const lone = await contact(owner.id);
    await asAdmin((q) => q("update public.contacts set owner_id = null where id = $1", [lone]));
    await submit(await create(admin, form, "contact", lone), { first_name: "ב" });
    // the maker (admin) is active and reads it
    expect(await to(lone)).toEqual([admin.id]);
  });

  it("leads: a lead link; a converted lead answers not found", async () => {
    const form = await template(admin, ["full_name", "company_name"], "lead");
    const l = await lead(member.id);
    const token = await create(member, form, "lead", l);
    expect((await page(token)).fields?.map((f) => [f.key, f.value])).toEqual([["full_name", "רון לוי"], ["company_name", null]]);
    expect(await submit(token, { company_name: "חברת רון" })).toEqual({ status: "saved", skipped: [] });
    expect(await asAdmin(async (q) => (await one<{ c: string }>(q, "select company_name as c from public.leads where id = $1", [l])).c)).toBe("חברת רון");
    const l2 = await lead(member.id);
    const t2 = await create(member, form, "lead", l2);
    await asAdmin((q) => q("update public.leads set converted_at = now() where id = $1", [l2]));
    expect((await pgError(page(t2))).code).toBe("P0002");
    expect((await pgError(create(member, form, "lead", l2))).hint).toBe("prefill_link:record");
  });

  it("limits: 60 per sender and 120 per link in 10 minutes, 10 submissions per link", async () => {
    const form = await template(admin, ["cf:diet"]);
    const token = await create(member, form, "contact", await contact(member.id));
    const ip = sender(9999);
    for (let i = 0; i < 60; i++) expect((await page(token, ip)).status).toBe("open");
    expect(await page(token, ip)).toEqual({ rate_limited: true });
    // another sender still gets the page
    expect((await page(token)).status).toBe("open");
    // submissions: 10 tries (an invalid one counts), then refused
    const t2 = await create(member, form, "contact", await contact(member.id));
    for (let i = 0; i < 10; i++) expect((await submit(t2, { "cf:diet": "x" })).status).toBe("invalid");
    expect(await submit(t2, { "cf:diet": "רגיל" })).toEqual({ rate_limited: true });
    // the link's own window: 120 calls whatever the sender
    await asAdmin((q) => q("update app.prefill_links set window_count = 120, window_started_at = now() where token_hash = $1", [sha256(token)]));
    expect(await page(token)).toEqual({ rate_limited: true });
    // no row in the counters keeps the hash
    const counters = await asAdmin(async (q) => (await q<Record<string, unknown>>("select * from app.prefill_link_view_counts")).rows);
    expect(JSON.stringify(counters)).not.toContain(ip);
  });

  it("a business that cannot write answers not found on the page, the submit and the done page", async () => {
    const form = await template(admin, ["first_name"]);
    const open = await create(member, form, "contact", await contact(member.id));
    const sent = await create(member, form, "contact", await contact(member.id));
    expect((await submit(sent, { first_name: "א" })).status).toBe("saved");
    for (const status of ["read_only", "suspended"]) {
      await asAdmin((q) => q("update public.organizations set status = $2 where id = $1", [org, status]));
      try {
        expect((await pgError(page(open))).code, status).toBe("P0002");
        expect((await pgError(submit(open, { first_name: "ב" }))).code, status).toBe("P0002");
        expect((await pgError(page(sent))).code, status).toBe("P0002");
      } finally {
        await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
      }
    }
    expect((await page(open)).status).toBe("open");
    // the done page answers only until the link's last day
    expect((await page(sent)).status).toBe("done");
    await asAdmin((q) => q("update app.prefill_links set expires_at = now() - interval '1 minute' where token_hash = $1", [sha256(sent)]));
    expect((await pgError(page(sent))).code).toBe("P0002");
  });

  it("editing a template narrows an open link but never widens it", async () => {
    const form = await template(admin, ["first_name", "city"]);
    const token = await create(member, form, "contact", await contact(member.id));
    await asUser(admin.id, (q) => q("update public.prefill_forms set fields = '{first_name,last_name}' where id = $1", [form]));
    expect((await page(token)).fields?.map((f) => f.key)).toEqual(["first_name"]);
    expect(await submit(token, { last_name: "x" })).toEqual({ status: "invalid", error: "unknown field: last_name" });
    expect(await submit(token, { city: "x" })).toEqual({ status: "invalid", error: "unknown field: city" });
    // putting a field back brings back only what the link was made with
    await asUser(admin.id, (q) => q("update public.prefill_forms set fields = '{city,first_name,last_name}' where id = $1", [form]));
    expect((await page(token)).fields?.map((f) => f.key)).toEqual(["first_name", "city"]);
  });

  it("built-in text with control, direction or zero-width characters is refused", async () => {
    const form = await template(admin, ["first_name", "city"]);
    const token = await create(member, form, "contact", await contact(member.id));
    expect(await submit(token, { first_name: "דנה\u202e" })).toEqual({ status: "invalid", error: "invalid field: first_name" });
    expect(await submit(token, { city: "תל\u200bאביב" })).toEqual({ status: "invalid", error: "invalid field: city" });
    expect(await submit(token, { city: "חיפה\nשורה" })).toEqual({ status: "invalid", error: "invalid field: city" });
    expect((await submit(token, { city: "חיפה" })).status).toBe("saved");
  });

  it("a sample lead a prefill link was sent to is kept (USR-04)", async () => {
    const sOwner = await createUser("pf-sample");
    const sOrg = await createOrg(sOwner.id, "עסק לדוגמה");
    await asUser(sOwner.id, (q) => q("select public.sample_data_add($1)", [sOrg]));
    const sample = await asAdmin(async (q) =>
      one<{ id: string; snapshot: unknown }>(q, "select lead_id as id, snapshot from app.sample_records where organization_id = $1 and lead_id is not null limit 1", [sOrg]),
    );
    const untouched = () => asAdmin(async (q) => (await one<{ r: boolean }>(q, "select app.sample_untouched($1, 'lead', $2, $3) as r", [sOrg, sample.id, JSON.stringify(sample.snapshot)])).r);
    expect(await untouched()).toBe(true);
    const form = await template(sOwner, ["full_name"], "lead", sOrg);
    await create(sOwner, form, "lead", sample.id, sOrg);
    expect(await untouched()).toBe(false);
  });

  it("merge moves a duplicate's links to the kept contact", async () => {
    const form = await template(admin, ["first_name"]);
    const keep = await contact(member.id);
    const dup = await contact(member.id);
    const token = await create(member, form, "contact", dup);
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep, dup]));
    expect(await asAdmin((q) => count(q, "select 1 from app.prefill_links where contact_id = $1 and token_hash = $2", [keep, sha256(token)]))).toBe(1);
    expect((await page(token)).status).toBe("open");
  });
});
