import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INDUSTRY_KITS, KIT_WORDING_VERSION } from "@/features/industry-templates/kits";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

// VRT-01: industry kits (owner (274) א + ב: clinics, studios & courses) through public.apply_industry_template.

type Added = Record<
  | "pipelines" | "stages" | "statuses" | "sources" | "fields" | "automations" | "products"
  | "meeting_types" | "message_templates" | "whatsapp_templates" | "forms" | "views",
  number
>;
type Result = { added: Added; limits: string[] };

const apply = (userId: string, org: string, key: string) =>
  asUser(userId, async (q) => (await q<{ r: Result }>("select public.apply_industry_template($1, $2) as r", [org, key])).rows[0].r);

const clinic = INDUSTRY_KITS.find((k) => k.template.industry === "clinic")!;
const studio = INDUSTRY_KITS.find((k) => k.template.industry === "studio")!;

// words that would make a field, template, option or product hold health or medical information
const MEDICAL_WORDS = [
  "אבחנה", "אבחון", "תרופה", "תרופות", "מחלה", "מחלות", "רגישות", "אלרגיה", "כאב", "תסמין", "סימפטום", "רפואי", "רפואית",
  "בריאותי", "הצהרת בריאות", "מצב בריאות", "ניתוח", "הריון", "לחץ דם", "סוכרת", "קופת חולים", "מרשם", "רופא", "היסטוריה",
  "diagnos", "medic", "allerg", "health",
];

const setPlan = (org: string, features: Record<string, boolean>, limits: Record<string, number> = {}) =>
  asAdmin((q) =>
    q("update public.subscriptions set feature_overrides = feature_overrides || $2, limit_overrides = $3 where organization_id = $1", [
      org,
      JSON.stringify(features),
      JSON.stringify(limits),
    ]),
  );

const applied = (org: string) =>
  asAdmin(async (q) => (await q<{ t: string[] }>("select industry_templates as t from public.organizations where id = $1", [org])).rows[0].t);

// every row a kit may add or touch, as text, so "nothing changed" is one comparison
const state = (org: string) =>
  asAdmin(async (q) => {
    const read = async (sql: string) => (await q<{ r: unknown }>(sql, [org])).rows.map((r) => JSON.stringify(r));
    return {
      products: await read("select name, kind, price_agorot, punch_entries, punch_meeting_type_ids, updated_at from public.products where organization_id = $1 order by id"),
      meetingTypes: await read("select name, duration_minutes, product_id, position, updated_at from public.meeting_types where organization_id = $1 order by id"),
      messages: await read("select name, channel, message_type, subject, body, wording_version, updated_at from public.message_templates where organization_id = $1 order by id"),
      whatsapp: await read("select name, body, position, updated_at from public.whatsapp_templates where organization_id = $1 order by id"),
      forms: await read("select name, kind, fields, is_active, updated_at from public.forms where organization_id = $1 order by id"),
      views: await read("select name, scope, config, updated_at from public.saved_views where organization_id = $1 order by id"),
      fields: await read("select object_type, key, label, options from public.field_definitions where organization_id = $1 order by id"),
      statuses: await read("select name, kind from public.lead_statuses where organization_id = $1 order by id"),
      documents: await read("select name, kind from public.document_templates where organization_id = $1 order by id"),
    };
  });

describe("apply_industry_template with a kit (VRT-01)", () => {
  let owner: { id: string }, org: string;

  beforeAll(async () => {
    owner = await createUser("kit-owner");
    org = await createOrg(owner.id);
    await setPlan(org, { products: true, punch_cards: true });
  });

  it("adds the clinics kit: template part, products, meeting types, message and WhatsApp templates, a form switched off and lead views", async () => {
    const result = await apply(owner.id, org, "clinic");
    expect(result.limits).toEqual([]);
    expect(result.added).toMatchObject({
      statuses: clinic.template.statuses.length,
      automations: clinic.template.automations.length,
      products: clinic.products.length,
      meeting_types: clinic.meeting_types.length,
      message_templates: clinic.message_templates.length,
      whatsapp_templates: clinic.whatsapp_templates.length,
      forms: 1,
      views: clinic.views.length,
    });
    expect(await applied(org)).toEqual(["clinic"]);

    const rows = await asAdmin(async (q) => ({
      treatment: (await q<{ id: string; product_id: string | null }>(
        "select id, product_id from public.meeting_types where organization_id = $1 and name = 'טיפול'", [org])).rows[0],
      product: (await q<{ id: string }>("select id from public.products where organization_id = $1 and name = 'טיפול'", [org])).rows[0],
      punch: (await q<{ kind: string; punch_entries: number; punch_validity_count: number; punch_validity_unit: string; punch_meeting_type_ids: string[] }>(
        "select kind, punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids from public.products where organization_id = $1 and kind = 'punch_card'",
        [org],
      )).rows,
      form: (await q<{ kind: string; is_active: boolean; fields: Array<{ key: string }>; owner_id: string }>(
        "select kind, is_active, fields, owner_id from public.forms where organization_id = $1 and name = $2", [org, clinic.form.name])).rows[0],
      messages: (await q<{ wording_version: string; problem: string | null }>(
        `select wording_version, app.message_template_sendable(organization_id, id) as problem
           from public.message_templates where organization_id = $1 and name = any($2)`,
        [org, clinic.message_templates.map((m) => m.name)],
      )).rows,
      views: (await q<{ scope: string; owner_id: string; status: string; name: string }>(
        `select v.scope::text as scope, v.owner_id, s.name as status, v.name from public.saved_views v
           join public.lead_statuses s on s.organization_id = v.organization_id and s.id::text = v.config -> 'filters' ->> 'status'
          where v.organization_id = $1 order by v.name`,
        [org],
      )).rows,
    }));
    expect(rows.treatment.product_id).toBe(rows.product.id);
    expect(rows.punch).toEqual([{ kind: "punch_card", punch_entries: 10, punch_validity_count: 6, punch_validity_unit: "months", punch_meeting_type_ids: [rows.treatment.id] }]);
    expect(rows.form).toMatchObject({ kind: "form", is_active: false, owner_id: owner.id });
    expect(rows.form.fields.map((f) => f.key)).toEqual(clinic.form.fields.map((f) => f.key));
    expect(rows.messages).toHaveLength(clinic.message_templates.length);
    for (const m of rows.messages) expect(m).toEqual({ wording_version: KIT_WORDING_VERSION, problem: null });
    expect(rows.views).toEqual(
      clinic.views.map((v) => ({ scope: "org", owner_id: owner.id, status: v.status, name: v.name })).sort((a, b) => (a.name < b.name ? -1 : 1)),
    );
  });

  it("applying again adds nothing and changes nothing", async () => {
    const before = await state(org);
    const again = await apply(owner.id, org, "clinic");
    expect(Object.values(again.added).every((n) => n === 0)).toBe(true);
    expect(again.limits).toEqual([]);
    expect(await state(org)).toEqual(before);
  });

  it("a second kit added later adds only its own missing items and keeps the first", async () => {
    const before = await state(org);
    const result = await apply(owner.id, org, "studio");
    expect(result.limits).toEqual([]);
    expect(result.added.meeting_types).toBe(studio.meeting_types.length);
    // "ליד חדש: לחזור תוך 15 דקות" is already there by name; only the studio's own automation is added
    expect(result.added.automations).toBe(1);
    const after = await state(org);
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      for (const row of before[key]) expect(after[key], key).toContain(row);
    }
    expect(await applied(org)).toEqual(["clinic", "studio"]);
  });

  it("never overwrites or renames what the business has: same names (outer spaces, case) are skipped", async () => {
    const u = await createUser("kit-edit");
    const o = await createOrg(u.id);
    await setPlan(o, { products: true, punch_cards: true });
    await asUser(u.id, async (q) => {
      await q("insert into public.meeting_types (organization_id, name, duration_minutes) values ($1, 'שיעור ניסיון', 20)", [o]);
      await q(
        "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'קבוצה חדשה נפתחת', 'sms', 'marketing', 'נוסח שלנו')",
        [o],
      );
      await q("insert into public.whatsapp_templates (organization_id, name, body) values ($1, 'תזכורת לשיעור', 'הנוסח של העסק')", [o]);
      await q("insert into public.products (organization_id, name, price_agorot) values ($1, 'מנוי חודשי', 999)", [o]);
    });
    const before = await state(o);
    const result = await apply(u.id, o, "studio");
    expect(result.limits).toEqual([]);
    expect(result.added.meeting_types).toBe(studio.meeting_types.length - 1);
    expect(result.added.message_templates).toBe(studio.message_templates.length - 1);
    expect(result.added.whatsapp_templates).toBe(studio.whatsapp_templates.length - 1);
    expect(result.added.products).toBe(studio.products.length - 1);
    const after = await state(o);
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      for (const row of before[key]) expect(after[key], key).toContain(row);
    }
    // the business's own type keeps its duration; the kit links no product to it
    const own = await asAdmin(async (q) =>
      (await q<{ duration_minutes: number; product_id: string | null }>(
        "select duration_minutes, product_id from public.meeting_types where organization_id = $1 and name = 'שיעור ניסיון'", [o])).rows,
    );
    expect(own).toEqual([{ duration_minutes: 20, product_id: null }]);
  });

  it("punch cards only with the key, products only with the catalog; nothing reported for either", async () => {
    const u = await createUser("kit-keys");
    const o = await createOrg(u.id);
    await setPlan(o, { products: true, punch_cards: false });
    const r1 = await apply(u.id, o, "clinic");
    expect(r1.limits).toEqual([]);
    expect(r1.added.products).toBe(clinic.products.filter((p) => p.kind !== "punch_card").length);
    expect(await applied(o)).toEqual(["clinic"]);

    const u2 = await createUser("kit-noprod");
    const o2 = await createOrg(u2.id);
    await setPlan(o2, { products: false, punch_cards: true });
    const r2 = await apply(u2.id, o2, "clinic");
    expect(r2.limits).toEqual([]);
    expect(r2.added.products).toBe(0);
    expect(r2.added.meeting_types).toBe(clinic.meeting_types.length);
    const linked = await asAdmin(async (q) =>
      Number((await q<{ n: string }>("select count(*) as n from public.meeting_types where organization_id = $1 and product_id is not null", [o2])).rows[0].n),
    );
    expect(linked).toBe(0);
  });

  it("skips and reports what is over a limit, and records the kit only once nothing was cut", async () => {
    const u = await createUser("kit-limits");
    const o = await createOrg(u.id);
    await setPlan(o, { products: true, punch_cards: true }, { max_forms: 0 });
    // the message template list at its cap of 50
    await asAdmin((q) =>
      q(
        `insert into public.message_templates (organization_id, name, channel, message_type, body)
         select $1, 'מילוי ' || g, 'sms', 'marketing', 'טקסט'
           from generate_series(1, 50 - (select count(*) from public.message_templates where organization_id = $1)) g`,
        [o],
      ),
    );
    const first = await apply(u.id, o, "clinic");
    expect([...first.limits].sort()).toEqual(["limit:max_forms", "message_templates:max"]);
    expect(first.added.forms).toBe(0);
    expect(first.added.message_templates).toBe(0);
    expect(first.added.meeting_types).toBe(clinic.meeting_types.length);
    expect(await applied(o)).toEqual([]);

    await setPlan(o, {}, {});
    const fillers = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.message_templates where organization_id = $1 and name like 'מילוי %' order by id limit 5", [o])).rows,
    );
    await asUser(u.id, (q) => q("delete from public.message_templates where id = any($1)", [fillers.map((f) => f.id)]));
    const second = await apply(u.id, o, "clinic");
    expect(second.limits).toEqual([]);
    expect(second.added).toMatchObject({ forms: 1, message_templates: clinic.message_templates.length, meeting_types: 0 });
    expect(await applied(o)).toEqual(["clinic"]);
  });

  it("only owners and admins of a writable business apply a kit; other roles, outsiders and a read-only business are refused", async () => {
    const u = await createUser("kit-roles");
    const o = await createOrg(u.id);
    const admin = await addMember(o, u.id, "admin");
    const others = [await addMember(o, u.id, "manager"), await addMember(o, u.id, "member"), await addMember(o, u.id, "viewer"), await createUser("kit-out")];
    const before = await state(o);
    for (const user of others) expect((await pgError(apply(user.id, o, "studio"))).code, user.email).toBe("42501");
    expect(await state(o)).toEqual(before);
    expect((await apply(admin.id, o, "studio")).added.forms).toBe(1);

    const ro = await createOrg(u.id, "עסק לקריאה");
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [ro]));
    expect((await pgError(apply(u.id, ro, "clinic"))).code).toBe("42501");
  });

  it("touches nothing in another business", async () => {
    const a = await createUser("kit-iso-a");
    const orgA = await createOrg(a.id);
    const b = await createUser("kit-iso-b");
    const orgB = await createOrg(b.id);
    await setPlan(orgB, { products: true, punch_cards: true });
    const before = await state(orgB);
    expect((await pgError(apply(a.id, orgB, "clinic"))).code).toBe("42501");
    await apply(a.id, orgA, "clinic");
    expect(await state(orgB)).toEqual(before);
  });

  it("adds marketing message templates only, never a service template the system sends itself", async () => {
    const u = await createUser("kit-msg-types");
    const o = await createOrg(u.id);
    for (const key of ["clinic", "studio"]) await apply(u.id, o, key);
    const types = await asAdmin(async (q) =>
      (await q<{ message_type: string }>(
        "select distinct message_type from public.message_templates where organization_id = $1 and wording_version = $2", [o, KIT_WORDING_VERSION])).rows,
    );
    expect(types).toEqual([{ message_type: "marketing" }]);
  });

  it("the form leaves out a field of the same key whose type public forms never show", async () => {
    const u = await createUser("kit-form-types");
    const o = await createOrg(u.id);
    // the business already has a lead field with the kit's key, of a type no public form shows
    await asUser(u.id, (q) =>
      q(
        "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'referral_source', 'הערות פנימיות', 'rich_text')",
        [o],
      ),
    );
    const result = await apply(u.id, o, "clinic");
    expect(result.added.forms).toBe(1);
    const keys = await asAdmin(async (q) =>
      ((await q<{ fields: Array<{ key: string }> }>("select fields from public.forms where organization_id = $1 and name = $2", [o, clinic.form.name])).rows[0]
        .fields).map((f) => f.key),
    );
    expect(keys).toEqual(clinic.form.fields.map((f) => f.key).filter((k) => k !== "cf:referral_source"));
    expect(keys).toContain("cf:treatment_type");
  });

  it("the clinics kit adds no health or medical field, option, template or document", async () => {
    const u = await createUser("kit-medical");
    const o = await createOrg(u.id);
    await setPlan(o, { products: true, punch_cards: true });
    const before = await state(o);
    await apply(u.id, o, "clinic");
    const after = await state(o);
    expect(after.documents).toEqual(before.documents);
    const added = (Object.keys(after) as Array<keyof typeof after>).flatMap((key) => after[key].filter((row) => !before[key].includes(row)));
    expect(added.length).toBeGreaterThan(0);
    for (const row of added) {
      const text = JSON.parse(row) as unknown;
      const flat = JSON.stringify(text).toLowerCase();
      for (const word of MEDICAL_WORDS) expect(flat, row).not.toContain(word.toLowerCase());
    }
  });

  // VRT-03: the clinic's sample data (public.sample_data_add after the kit) holds no health or medical content either
  it("the clinic's sample data holds no health or medical word", async () => {
    const u = await createUser("kit-medical-sample");
    const o = await createOrg(u.id);
    await setPlan(o, { products: true, punch_cards: true });
    await apply(u.id, o, "clinic");
    const added = await asUser(u.id, async (q) => (await q<{ r: { kit: string } }>("select public.sample_data_add($1) as r", [o])).rows[0].r);
    expect(added.kit).toBe("clinic");
    const rows = await asAdmin(async (q) => {
      const read = async (sql: string) => (await q<{ r: unknown }>(sql, [o])).rows.map((r) => JSON.stringify(r).toLowerCase());
      return [
        ...(await read("select to_jsonb(l) - 'id' as r from public.leads l join app.sample_records s on s.lead_id = l.id where s.organization_id = $1")),
        ...(await read("select to_jsonb(c) - 'id' as r from public.contacts c join app.sample_records s on s.contact_id = c.id where s.organization_id = $1")),
        ...(await read("select to_jsonb(d) - 'id' as r from public.deals d join app.sample_records s on s.deal_id = d.id where s.organization_id = $1")),
        ...(await read("select to_jsonb(t) - 'id' as r from public.tasks t join app.sample_records s on s.task_id = t.id where s.organization_id = $1")),
        ...(await read("select c.name as r from public.punch_cards c join app.sample_punch_cards s on s.punch_card_id = c.id where s.organization_id = $1")),
      ];
    });
    expect(rows.length).toBe(9);
    for (const row of rows) for (const word of MEDICAL_WORDS) expect(row, row).not.toContain(word.toLowerCase());
  });
});
