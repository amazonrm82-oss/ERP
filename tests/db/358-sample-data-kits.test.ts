import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INDUSTRY_KITS } from "@/features/industry-templates/kits";
import { SAMPLE_KIT_CONTENT, sampleDataKit } from "@/features/setup/sample-kits";

import { asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

// VRT-03: sample data by industry (extends USR-04). A business with an industry kit gets that industry's sample set
// through public.sample_data_add; the removal rule of USR-04 holds for every record, and for the sample punch card.

type U = { id: string };
type Added = { created: number; kit?: string; punch_cards?: number };
type Row = { record_type: string; record_id: string; removable: boolean };

const add = (userId: string, org: string) =>
  asUser(userId, async (q) => (await q<{ r: Added }>("select public.sample_data_add($1) as r", [org])).rows[0].r);
const remove = (userId: string, org: string) =>
  asUser(userId, async (q) => (await q<{ r: { removed: number; kept: number } }>("select public.sample_data_remove($1) as r", [org])).rows[0].r);
const records = (userId: string, org: string) =>
  asUser(userId, async (q) => (await q<Row>("select * from public.sample_data_records($1)", [org])).rows);
const apply = (userId: string, org: string, key: string) =>
  asUser(userId, (q) => q("select public.apply_industry_template($1, $2)", [org, key]));

const setPlan = (org: string, features: Record<string, boolean>) =>
  asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || $2 where organization_id = $1", [org, JSON.stringify(features)]));

const cards = (org: string) =>
  asAdmin(async (q) => (await q<{ id: string; contact_id: string; name: string; status: string }>("select id, contact_id, name, status from public.punch_cards where organization_id = $1", [org])).rows);
const cardNotes = (org: string) => asAdmin((q) => count(q, "select 1 from app.sample_punch_cards where organization_id = $1", [org]));

// every text of the sample rows of a business, for the medical word check
const sampleTexts = (org: string) =>
  asAdmin(async (q) => {
    const read = async (sql: string) => (await q<{ r: unknown }>(sql, [org])).rows.map((r) => JSON.stringify(r).toLowerCase());
    return [
      ...(await read("select l.full_name, l.email, l.message, l.custom_fields from public.leads l join app.sample_records s on s.lead_id = l.id where s.organization_id = $1")),
      ...(await read("select c.full_name, c.email, c.city, c.custom_fields from public.contacts c join app.sample_records s on s.contact_id = c.id where s.organization_id = $1")),
      ...(await read("select d.name, d.custom_fields from public.deals d join app.sample_records s on s.deal_id = d.id where s.organization_id = $1")),
      ...(await read("select t.title from public.tasks t join app.sample_records s on s.task_id = t.id where s.organization_id = $1")),
      ...(await read("select c.name from public.punch_cards c join app.sample_punch_cards s on s.punch_card_id = c.id where s.organization_id = $1")),
    ];
  });

// the closed list of tests/db/356-industry-kits
const MEDICAL_WORDS = [
  "אבחנה", "אבחון", "תרופה", "תרופות", "מחלה", "מחלות", "רגישות", "אלרגיה", "כאב", "תסמין", "סימפטום", "רפואי", "רפואית",
  "בריאותי", "הצהרת בריאות", "מצב בריאות", "ניתוח", "הריון", "לחץ דם", "סוכרת", "קופת חולים", "מרשם", "רופא", "היסטוריה",
  "diagnos", "medic", "allerg", "health",
];

const clinic = SAMPLE_KIT_CONTENT.find((c) => c.kit === "clinic")!;
const studio = SAMPLE_KIT_CONTENT.find((c) => c.kit === "studio")!;

describe("sample data by industry (VRT-03)", () => {
  let owner: U, org: string;

  beforeAll(async () => {
    owner = await createUser("vrt3-owner");
    org = await createOrg(owner.id);
    await setPlan(org, { products: true, punch_cards: true });
    await apply(owner.id, org, "clinic");
  });

  it("the database's sample sets equal SAMPLE_KIT_CONTENT in src/features/setup/sample-kits.ts", async () => {
    for (const content of SAMPLE_KIT_CONTENT) {
      const { kit, ...rest } = content;
      const db = await asAdmin(async (q) => (await q<{ t: unknown }>("select app.sample_kit_content($1) as t", [kit])).rows[0].t);
      expect(db).toEqual(rest);
    }
    for (const key of ["services", "health", "", "x"]) {
      expect(await asAdmin(async (q) => (await q<{ t: unknown }>("select app.sample_kit_content($1) as t", [key])).rows[0].t)).toBeNull();
    }
    expect((await pgError(asUser(owner.id, (q) => q("select app.sample_kit_content('clinic')")))).code).toBe("42501");
  });

  it("the sets name only what their kit adds (statuses, sources, pipeline and stage, fields and values, the punch card product)", () => {
    for (const content of SAMPLE_KIT_CONTENT) {
      const kit = INDUSTRY_KITS.find((k) => k.template.industry === content.kit)!;
      const t = kit.template;
      for (const lead of content.leads) {
        expect(t.statuses).toContain(lead.status);
        expect(t.sources).toContain(lead.source);
      }
      expect(t.pipeline?.name).toBe(content.deal.pipeline);
      expect((t.pipeline?.stages ?? []).filter((s) => s.kind === "open").map((s) => s.name)).toContain(content.deal.stage);
      expect(kit.products.filter((p) => p.kind === "punch_card").map((p) => p.name)).toContain(content.punch_card!.product);
      const check = (object: string, values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) {
          const field = t.fields.find((f) => f.object_type === object && f.key === key);
          expect(field, `${content.kit} ${object}.${key}`).toBeDefined();
          if (field!.field_type === "select") expect(field!.options).toContain(value);
          if (field!.field_type === "multi_select") for (const v of value as string[]) expect(field!.options).toContain(v);
        }
      };
      content.leads.forEach((l) => check("lead", l.custom_fields));
      content.contacts.forEach((c) => check("contact", c.custom_fields));
      check("deal", content.deal.custom_fields);
    }
  });

  it("app.sample_kit follows the last kit applied, else the sign-up industry (= sampleDataKit)", async () => {
    const cases: Array<{ industry: string | null; industry_templates: string[] }> = [
      { industry: null, industry_templates: [] },
      { industry: "health", industry_templates: [] },
      { industry: "education", industry_templates: [] },
      { industry: "services", industry_templates: [] },
      { industry: null, industry_templates: ["services"] },
      { industry: "services", industry_templates: ["clinic", "services"] },
      { industry: "health", industry_templates: ["clinic", "studio"] },
      { industry: "education", industry_templates: ["health"] },
    ];
    const u = await createUser("vrt3-kit");
    const o = await createOrg(u.id);
    for (const c of cases) {
      const db = await asAdmin(async (q) => {
        await q("update public.organizations set industry = $2, industry_templates = $3 where id = $1", [o, c.industry, c.industry_templates]);
        return (await q<{ k: string | null }>("select app.sample_kit($1) as k", [o])).rows[0].k;
      });
      expect(db, JSON.stringify(c)).toBe(sampleDataKit(c));
    }
  });

  it("a clinic gets inquiries, clients, a series of sessions, two tasks and a punch card, all in the kit's words", async () => {
    const result = await add(owner.id, org);
    expect(result).toEqual({ created: 8, kit: "clinic", punch_cards: 1 });
    const rows = await records(owner.id, org);
    expect(rows.map((r) => r.record_type).sort()).toEqual(["contact", "contact", "deal", "lead", "lead", "lead", "task", "task"]);
    expect(rows.every((r) => r.removable)).toBe(true);

    await asAdmin(async (q) => {
      const leads = (
        await q<{ full_name: string; status: string; source: string; custom_fields: Record<string, unknown>; owner_id: string }>(
          `select l.full_name, st.name as status, so.name as source, l.custom_fields, l.owner_id
             from public.leads l join app.sample_records s on s.lead_id = l.id
             join public.lead_statuses st on st.id = l.status_id join public.lead_sources so on so.id = l.source_id
            where s.organization_id = $1`,
          [org],
        )
      ).rows;
      expect(leads.map((l) => l.full_name).sort()).toEqual(clinic.leads.map((l) => `${l.full_name} (דוגמה)`).sort());
      for (const lead of clinic.leads) {
        const row = leads.find((l) => l.full_name === `${lead.full_name} (דוגמה)`)!;
        expect(row.status).toBe(lead.status);
        expect(row.source).toBe(lead.source);
        expect(row.custom_fields).toMatchObject(lead.custom_fields);
        expect(row.owner_id).toBe(owner.id);
      }
      const deal = (
        await q<{ name: string; pipeline: string; stage: string; contact: string; custom_fields: Record<string, unknown> }>(
          `select d.name, p.name as pipeline, st.name as stage, c.full_name as contact, d.custom_fields
             from public.deals d join app.sample_records s on s.deal_id = d.id
             join public.pipelines p on p.id = d.pipeline_id join public.stages st on st.id = d.stage_id
             join public.contacts c on c.id = d.contact_id
            where s.organization_id = $1`,
          [org],
        )
      ).rows[0];
      expect(deal).toMatchObject({ name: `${clinic.deal.name} (דוגמה)`, pipeline: clinic.deal.pipeline, stage: clinic.deal.stage });
      expect(deal.contact).toBe("יעל ברגר (דוגמה)");
      expect(deal.custom_fields).toMatchObject(clinic.deal.custom_fields);
      // automations do not react, nobody is notified, no timeline entry
      const ids = rows.map((r) => r.record_id);
      expect(await count(q, "select 1 from public.outbox_events where entity_id = any ($1) and coalesce(payload ->> 'origin', '') <> 'automation'", [ids])).toBe(0);
      expect(await count(q, "select 1 from public.notifications where entity_id = any ($1)", [ids])).toBe(0);
      expect(await count(q, "select 1 from public.activities where organization_id = $1", [org])).toBe(0);
    });

    const opened = await cards(org);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ name: clinic.punch_card!.product, status: "active" });
    expect(await cardNotes(org)).toBe(1);
  });

  it("holds no health or medical word", async () => {
    const texts = await sampleTexts(org);
    expect(texts.length).toBe(9);
    for (const text of texts) for (const word of MEDICAL_WORDS) expect(text, text).not.toContain(word.toLowerCase());
  });

  it("is added once while it is there", async () => {
    expect((await pgError(add(owner.id, org))).hint).toBe("sample:exists");
  });

  it("one call removes the untouched records with their punch card; the kit's own lists stay", async () => {
    const productsBefore = await asAdmin((q) => count(q, "select 1 from public.products where organization_id = $1", [org]));
    expect(await remove(owner.id, org)).toEqual({ removed: 8, kept: 0 });
    expect(await records(owner.id, org)).toEqual([]);
    expect(await cards(org)).toEqual([]);
    expect(await cardNotes(org)).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.products where organization_id = $1", [org]))).toBe(productsBefore);
  });

  it("a touched record stays; a punch card a person changed keeps its contact", async () => {
    await add(owner.id, org);
    const card = (await cards(org))[0];
    // the owner cancels the sample card: the card is real work now, so its contact stays (with the card)
    await asUser(owner.id, (q) => q("select public.punch_card_cancel($1, $2, $3)", [org, card.id, "בדיקה"]));
    // a person edits one sample lead
    await asUser(owner.id, (q) =>
      q("update public.leads set email = 'changed@example.com' where organization_id = $1 and full_name = $2", [org, `${clinic.leads[1].full_name} (דוגמה)`]),
    );
    const res = await remove(owner.id, org);
    expect(res.kept).toBeGreaterThanOrEqual(2);
    const left = await records(owner.id, org);
    expect(left.every((r) => !r.removable)).toBe(true);
    expect(left.map((r) => r.record_id)).toContain(card.contact_id);
    expect(await cards(org)).toHaveLength(1);
    // the other contact had no card and nothing linked: removed
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where organization_id = $1 and full_name = $2", [org, "משה פרידמן (דוגמה)"]))).toBe(0);
  });

  it("a sample card that was used keeps its contact", async () => {
    const u = await createUser("vrt3-used");
    const o = await createOrg(u.id);
    await setPlan(o, { products: true, punch_cards: true });
    await apply(u.id, o, "clinic");
    await add(u.id, o);
    const card = (await cards(o))[0];
    // the server records a use (the shape PKG-02 writes for a held meeting)
    await asAdmin((q) => q("insert into public.punch_card_uses (organization_id, card_id, used_on) values ($1, $2, current_date)", [o, card.id]));
    const left = (await remove(u.id, o)).kept;
    expect(left).toBeGreaterThanOrEqual(1);
    expect((await records(u.id, o)).map((r) => r.record_id)).toContain(card.contact_id);
  });

  it("without the plan key punch_cards a studio gets its set without a card", async () => {
    const u = await createUser("vrt3-studio");
    const o = await createOrg(u.id);
    await setPlan(o, { products: true, punch_cards: false });
    await apply(u.id, o, "studio");
    expect(await add(u.id, o)).toEqual({ created: 8, kit: "studio", punch_cards: 0 });
    expect(await cards(o)).toEqual([]);
    const contacts = await asAdmin(async (q) =>
      (await q<{ full_name: string; custom_fields: Record<string, unknown> }>(
        "select c.full_name, c.custom_fields from public.contacts c join app.sample_records s on s.contact_id = c.id where s.organization_id = $1",
        [o],
      )).rows,
    );
    expect(contacts.map((c) => c.full_name).sort()).toEqual(studio.contacts.map((c) => `${c.first_name} ${c.last_name} (דוגמה)`).sort());
    expect(contacts.find((c) => c.full_name.startsWith("עידו"))!.custom_fields).toMatchObject({ parent_name: "רינת שמש" });
  });

  it("with the key but no kit products (no products flag) a studio gets no card", async () => {
    const u = await createUser("vrt3-noproducts");
    const o = await createOrg(u.id);
    await setPlan(o, { products: false, punch_cards: true });
    await apply(u.id, o, "studio");
    expect((await add(u.id, o)).punch_cards).toBe(0);
  });

  it("an education business that applied nothing gets the studio's words with its own lists, and no unknown fields", async () => {
    const u = await createUser("vrt3-edu");
    const o = await createOrg(u.id);
    await asAdmin((q) => q("update public.organizations set industry = 'education' where id = $1", [o]));
    expect(await add(u.id, o)).toEqual({ created: 8, kit: "studio", punch_cards: 0 });
    await asAdmin(async (q) => {
      const leads = (await q<{ full_name: string; is_default: boolean; custom_fields: Record<string, unknown> }>(
        `select l.full_name, st.is_default, l.custom_fields from public.leads l join app.sample_records s on s.lead_id = l.id
           join public.lead_statuses st on st.id = l.status_id where s.organization_id = $1`,
        [o],
      )).rows;
      expect(leads).toHaveLength(3);
      for (const lead of leads) {
        // the business has none of the kit's statuses or fields: the default open status, no custom values
        expect(lead.is_default).toBe(true);
        expect(lead.custom_fields).toEqual({});
      }
      const pipeline = (await q<{ is_default: boolean }>(
        "select p.is_default from public.deals d join app.sample_records s on s.deal_id = d.id join public.pipelines p on p.id = d.pipeline_id where s.organization_id = $1",
        [o],
      )).rows[0];
      expect(pipeline.is_default).toBe(true);
    });
    expect(await remove(u.id, o)).toEqual({ removed: 8, kept: 0 });
  });

  it("a business without a kit keeps the generic set (USR-04, unchanged)", async () => {
    const u = await createUser("vrt3-generic");
    const o = await createOrg(u.id);
    expect(await add(u.id, o)).toEqual({ created: 9 });
    expect(await asAdmin((q) => count(q, "select 1 from public.companies where organization_id = $1 and name = 'סטודיו כרמל (דוגמה)'", [o]))).toBe(1);
  });

  it("no access across businesses, and the card notes are closed to clients", async () => {
    const outsider = await createUser("vrt3-outsider");
    await createOrg(outsider.id);
    expect((await pgError(add(outsider.id, org))).code).toBe("42501");
    expect((await pgError(remove(outsider.id, org))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select * from app.sample_punch_cards")))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select app.sample_kit($1)", [org])))).code).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("select app.sample_kit_add($1, 'clinic', null, null, null, null, null, 'ILS')", [org])))).code,
    ).toBe("42501");
  });
});
