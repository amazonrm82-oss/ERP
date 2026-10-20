import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INDUSTRY_TEMPLATES, previewTemplate, TEMPLATE_PRODUCTS, templateProducts } from "@/features/industry-templates/templates";
import { INDUSTRIES } from "@/features/onboarding/options";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Result = { added: Record<"pipelines" | "stages" | "statuses" | "sources" | "fields" | "automations" | "products", number>; limits: string[] };

// FLD-05: industry templates add a pipeline, stages, statuses, sources, custom
// fields and (switched off) automations; nothing is deleted or renamed.

const apply = (userId: string, org: string, industry: string) =>
  asUser(userId, async (q) => (await q<{ r: Result }>("select public.apply_industry_template($1, $2) as r", [org, industry])).rows[0].r);

type Snapshot = {
  pipelines: string[];
  stages: Record<string, string[]>;
  statuses: Array<{ name: string; kind: string }>;
  sources: string[];
  fields: string[];
  automations: Array<{ name: string; active: boolean; key: string | null }>;
};

const snapshot = (org: string): Promise<Snapshot> =>
  asAdmin(async (q) => {
    const pipelines = (
      await q<{ id: string; name: string }>(
        "select id, name from public.pipelines where organization_id = $1 and deleted_at is null order by position, created_at",
        [org],
      )
    ).rows;
    const stages: Record<string, string[]> = {};
    for (const p of pipelines) {
      stages[p.name] = (await q<{ name: string }>("select name from public.stages where pipeline_id = $1 order by position, created_at", [p.id])).rows.map(
        (r) => r.name,
      );
    }
    const statuses = (
      await q<{ name: string; kind: string }>("select name, kind::text from public.lead_statuses where organization_id = $1 order by position, created_at", [org])
    ).rows;
    const sources = (await q<{ name: string }>(`select name from public.lead_sources where organization_id = $1 order by name collate "C"`, [org])).rows.map(
      (r) => r.name,
    );
    const fields = (
      await q<{ f: string }>(`select object_type || ':' || key as f from public.field_definitions where organization_id = $1 order by (object_type || ':' || key) collate "C"`, [org])
    ).rows.map((r) => r.f);
    const automations = (
      await q<{ name: string; active: boolean; key: string | null }>(
        `select name, is_active as active, template_key as key from public.automations where organization_id = $1 order by name collate "C"`,
        [org],
      )
    ).rows;
    return { pipelines: pipelines.map((p) => p.name), stages, statuses, sources, fields, automations };
  });

// whether the organization's plan holds the product catalog (sample products are added only then)
const hasProducts = (org: string) =>
  asAdmin(async (q) => (await q<{ f: boolean }>("select app.org_has_feature($1, 'products') as f", [org])).rows[0].f);

const productRows = (org: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ name: string; kind: string; price_agorot: string; price_includes_vat: boolean; vat_kind: string; billing: string; is_active: boolean }>(
          `select name, kind, price_agorot, price_includes_vat, vat_kind, billing, is_active from public.products where organization_id = $1 order by name collate "C"`,
          [org],
        )
      ).rows,
  );

const applied = (org: string) =>
  asAdmin(async (q) => (await q<{ t: string[] }>("select industry_templates as t from public.organizations where id = $1", [org])).rows[0].t);

describe("industry templates: data (FLD-05)", () => {
  it("the database copy equals src/features/industry-templates/templates.ts", async () => {
    for (const template of INDUSTRY_TEMPLATES) {
      const db = await asAdmin(async (q) => (await q<{ t: unknown }>("select app.industry_template($1) as t", [template.industry])).rows[0].t);
      expect(db, template.industry).toEqual(JSON.parse(JSON.stringify(template)));
    }
    expect(await asAdmin(async (q) => (await q<{ t: unknown }>("select app.industry_template('nope') as t")).rows[0].t)).toBeNull();
  });

  it("the database's sample products equal TEMPLATE_PRODUCTS (FLD-05, wave 2)", async () => {
    for (const template of INDUSTRY_TEMPLATES) {
      const db = await asAdmin(async (q) => (await q<{ t: unknown }>("select app.industry_template_products($1) as t", [template.industry])).rows[0].t);
      expect(db, template.industry).toEqual(JSON.parse(JSON.stringify(templateProducts(template.industry))));
    }
    expect(Object.keys(TEMPLATE_PRODUCTS).sort()).toEqual(INDUSTRY_TEMPLATES.map((t) => t.industry).sort());
    expect(await asAdmin(async (q) => (await q<{ t: unknown }>("select app.industry_template_products('nope') as t")).rows[0].t)).toBeNull();
    const owner = await createUser("tpl-products-data");
    expect((await pgError(asUser(owner.id, (q) => q("select app.industry_template_products('services')")))).code).toBe("42501");
  });

  it("every industry of the sign-up form has a template", () => {
    expect(INDUSTRY_TEMPLATES.map((t) => t.industry).sort()).toEqual(INDUSTRIES.map((i) => i.value).sort());
  });

  it("clients cannot call the data function", async () => {
    const owner = await createUser("tpl-data");
    expect((await pgError(asUser(owner.id, (q) => q("select app.industry_template('services')")))).code).toBe("42501");
  });
});

describe("apply_industry_template (FLD-05)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;

  beforeAll(async () => {
    owner = await createUser("tpl-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    manager = await addMember(org, owner.id, "manager");
    member = await addMember(org, owner.id, "member");
    viewer = await addMember(org, owner.id, "viewer");
    outsider = await createUser("tpl-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  it("only owners and admins may apply; other roles, outsiders and anon are refused", async () => {
    for (const user of [manager, member, viewer, outsider]) {
      expect((await pgError(apply(user.id, org, "services"))).code, user.email).toBe("42501");
    }
    expect((await pgError(asAnon((q) => q("select public.apply_industry_template($1, 'services')", [org]))))).toMatchObject({ code: "42501" });
    expect(await applied(org)).toEqual([]);
  });

  it("refuses an unknown template", async () => {
    const err = await pgError(apply(owner.id, org, "spaceships"));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("template:unknown");
  });

  it("adds the template without deleting, renaming or reordering what exists", async () => {
    // a status that the template also has, written differently: it is not added again
    await asUser(owner.id, (q) =>
      q("insert into public.lead_statuses (organization_id, name, kind, position) values ($1, '  נקבע סיור ', 'open', 4)", [org]),
    );
    const before = await snapshot(org);
    const template = INDUSTRY_TEMPLATES.find((t) => t.industry === "real_estate")!;

    const result = await apply(owner.id, org, "real_estate");
    expect(result.limits).toEqual([]);
    expect(result.added).toEqual({
      pipelines: 1,
      stages: template.pipeline!.stages.length,
      statuses: template.statuses.length - 1,
      sources: template.sources.length,
      fields: template.fields.length,
      automations: template.automations.length,
      products: (await hasProducts(org)) ? templateProducts("real_estate").length : 0,
    });

    const after = await snapshot(org);
    // the existing pipeline is untouched and the template's one follows it
    expect(after.pipelines).toEqual([...before.pipelines, template.pipeline!.name]);
    for (const name of before.pipelines) expect(after.stages[name]).toEqual(before.stages[name]);
    expect(after.stages[template.pipeline!.name]).toEqual(template.pipeline!.stages.map((s) => s.name));
    // every old status keeps its name and relative order; the new open one comes before the closed ones
    const names = after.statuses.map((s) => s.name);
    expect(names.filter((n) => before.statuses.some((b) => b.name === n))).toEqual(before.statuses.map((s) => s.name));
    expect(names).toContain("מחפש נכס");
    const firstClosed = after.statuses.findIndex((s) => s.kind !== "open");
    expect(names.indexOf("מחפש נכס")).toBeLessThan(firstClosed);
    expect(after.statuses.slice(firstClosed).every((s) => s.kind !== "open")).toBe(true);
    expect(after.sources).toEqual(expect.arrayContaining([...before.sources, ...template.sources]));
    expect(after.fields).toEqual(expect.arrayContaining(template.fields.map((f) => `${f.object_type}:${f.key}`)));
    // automations arrive switched off, marked with the template
    const autos = after.automations.filter((a) => a.key?.startsWith("industry:real_estate:"));
    expect(autos).toHaveLength(template.automations.length);
    expect(autos.every((a) => !a.active)).toBe(true);
    expect(await applied(org)).toEqual(["real_estate"]);
  });

  it("applying again adds nothing", async () => {
    const before = await snapshot(org);
    const result = await apply(admin.id, org, "real_estate");
    expect(result).toEqual({ added: { pipelines: 0, stages: 0, statuses: 0, sources: 0, fields: 0, automations: 0, products: 0 }, limits: [] });
    expect(await snapshot(org)).toEqual(before);
    expect(await applied(org)).toEqual(["real_estate"]);
  });

  it("missing stages go into the existing pipeline of that name, before its won stage, with one move each", async () => {
    const pipelineName = INDUSTRY_TEMPLATES.find((t) => t.industry === "real_estate")!.pipeline!.name;
    await asAdmin((q) =>
      q(
        `update public.stages s set name = s.name || ' (שלנו)' from public.pipelines p
          where p.id = s.pipeline_id and p.organization_id = $1 and p.name = $2 and s.name in ('סיור בנכס', 'משא ומתן')`,
        [org, pipelineName],
      ),
    );
    const lastAudit = await asAdmin(async (q) => Number((await q<{ m: string }>("select coalesce(max(id), 0) as m from public.audit_log")).rows[0].m));
    const result = await apply(owner.id, org, "real_estate");
    expect(result.added).toMatchObject({ pipelines: 0, stages: 2 });
    const stages = (await snapshot(org)).stages[pipelineName];
    expect(stages).toEqual(["פנייה ראשונה", "סיור בנכס (שלנו)", "משא ומתן (שלנו)", "זיכרון דברים", "סיור בנכס", "משא ומתן", "חוזה נחתם", "לא נסגר"]);
    // the won and lost stages moved once each (one update for both new stages), not once per new stage
    const moves = await asAdmin(async (q) =>
      Number(
        (
          await q<{ n: string }>(
            "select count(*) as n from public.audit_log where id > $1 and organization_id = $2 and entity_type = 'stages' and action = 'update'",
            [lastAudit, org],
          )
        ).rows[0].n,
      ),
    );
    expect(moves).toBe(2);
  });

  it("names are compared like btrim (outer spaces only), the same rule as the preview", async () => {
    const u = await createUser("tpl-names");
    const o = await createOrg(u.id);
    await asUser(u.id, async (q) => {
      // counts as the same name: outer spaces
      await q("insert into public.lead_sources (organization_id, name) values ($1, '  יד2 ')", [o]);
      // do not count: a tab, a no-break space, another case
      await q("insert into public.lead_statuses (organization_id, name, kind, position) values ($1, E'\\tנקבע סיור', 'open', 1)", [o]);
      await q("insert into public.lead_sources (organization_id, name) values ($1, E'שלט על הנכס\\u00a0')", [o]);
    });
    const template = INDUSTRY_TEMPLATES.find((t) => t.industry === "real_estate")!;
    const existing = await asAdmin(async (q) => ({
      pipelines: (
        await q<{ name: string }>("select name from public.pipelines where organization_id = $1 and deleted_at is null order by position, created_at", [o])
      ).rows.map((p) => ({ name: p.name, stages: [] })),
      statuses: (await q<{ name: string }>("select name from public.lead_statuses where organization_id = $1", [o])).rows.map((r) => r.name),
      sources: (await q<{ name: string }>("select name from public.lead_sources where organization_id = $1", [o])).rows.map((r) => r.name),
      fields: (await q<{ object_type: string; key: string; label: string }>("select object_type, key, label from public.field_definitions where organization_id = $1", [o])).rows,
      automations: (await q<{ name: string; template_key: string | null }>("select name, template_key from public.automations where organization_id = $1", [o])).rows,
      products: (await q<{ f: boolean }>("select app.org_has_feature($1, 'products') as f", [o])).rows[0].f
        ? (await q<{ name: string }>("select name from public.products where organization_id = $1", [o])).rows.map((r) => r.name)
        : null,
    }));
    expect(existing.statuses).toContain("\tנקבע סיור");
    const preview = previewTemplate(template, existing);
    const result = await apply(u.id, o, "real_estate");
    expect(result.added).toEqual({
      pipelines: preview.pipeline?.isNew ? 1 : 0,
      stages: preview.stages.length,
      statuses: preview.statuses.length,
      sources: preview.sources.length,
      fields: preview.fields.length,
      automations: preview.automations.length,
      products: preview.products.length,
    });
    expect(preview.sources).toEqual(["שלט על הנכס"]);
    expect(preview.statuses).toEqual(template.statuses);
  });

  it("another template adds its own lists; a field label that exists on the object is skipped", async () => {
    await asUser(owner.id, (q) =>
      q(
        "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'deal', 'my_start', 'מועד התחלה', 'date')",
        [org],
      ),
    );
    const result = await apply(owner.id, org, "construction");
    const template = INDUSTRY_TEMPLATES.find((t) => t.industry === "construction")!;
    expect(result.added.fields).toBe(template.fields.length - 1);
    const fields = (await snapshot(org)).fields;
    expect(fields).not.toContain("deal:start_date");
    expect(fields).toContain("deal:my_start");
    expect(await applied(org)).toEqual(["real_estate", "construction"]);
  });

  it("the general template adds no pipeline", async () => {
    const before = await snapshot(org);
    const result = await apply(owner.id, org, "other");
    expect(result.added.pipelines).toBe(0);
    expect(result.added.stages).toBe(0);
    expect((await snapshot(org)).pipelines).toEqual(before.pipelines);
  });

  it("touches nothing in another organization", async () => {
    const before = await snapshot(otherOrg);
    await apply(owner.id, org, "education");
    expect(await snapshot(otherOrg)).toEqual(before);
    expect(await applied(otherOrg)).toEqual([]);
    // and an admin of org cannot apply to otherOrg
    expect((await pgError(apply(admin.id, otherOrg, "education"))).code).toBe("42501");
  });

  it("the change of the organization is in its audit log, with the actor", async () => {
    const entry = await asAdmin(async (q) =>
      (
        await q<{ actor: string; changes: Record<string, unknown> }>(
          `select actor_id as actor, changes from public.audit_log
            where organization_id = $1 and entity_type = 'organizations' and changes ? 'industry_templates'
            order by id desc limit 1`,
          [org],
        )
      ).rows[0],
    );
    expect(entry.actor).toBe(owner.id);
    expect(entry.changes.industry_templates).toMatchObject({ new: expect.arrayContaining(["education"]) });
  });

  it("a read-only organization is refused", async () => {
    const u = await createUser("tpl-ro");
    const ro = await createOrg(u.id);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [ro]));
    expect((await pgError(apply(u.id, ro, "services"))).code).toBe("42501");
  });

  it("clients cannot write the applied list themselves", async () => {
    const err = await pgError(asUser(owner.id, (q) => q("update public.organizations set industry_templates = '{}' where id = $1", [org])));
    expect(err.code).toBe("42501");
  });
});

describe("apply_industry_template and plan limits (FLD-05)", () => {
  it("skips what is over a limit, reports it, and adds the rest; a bigger plan adds the rest later", async () => {
    const owner = await createUser("tpl-limits");
    const org = await createOrg(owner.id);
    // free plan: one pipeline; and one custom field per object type
    await asAdmin((q) =>
      q(
        `update public.subscriptions set plan_key = 'free', status = 'active', limit_overrides = '{"max_custom_fields_per_object": 1}'
          where organization_id = $1`,
        [org],
      ),
    );
    const template = INDUSTRY_TEMPLATES.find((t) => t.industry === "real_estate")!;
    const leadFields = template.fields.filter((f) => f.object_type === "lead").length;
    expect(leadFields).toBeGreaterThan(1);

    const first = await apply(owner.id, org, "real_estate");
    expect([...first.limits].sort()).toEqual(["limit:max_custom_fields_per_object", "limit:max_pipelines"]);
    expect(first.added).toMatchObject({ pipelines: 0, stages: 0, statuses: template.statuses.length, sources: template.sources.length });
    // one lead field and one deal field
    expect(first.added.fields).toBe(2);
    const snap = await snapshot(org);
    expect(snap.pipelines).toHaveLength(1);
    expect(snap.automations.filter((a) => a.key?.startsWith("industry:"))).toHaveLength(template.automations.length);
    // cut short by a limit: not recorded, so the screens keep offering it
    expect(await applied(org)).toEqual([]);

    await asAdmin((q) => q("update public.subscriptions set plan_key = 'pro', limit_overrides = '{}' where organization_id = $1", [org]));
    const second = await apply(owner.id, org, "real_estate");
    expect(second.limits).toEqual([]);
    expect(second.added).toMatchObject({ pipelines: 1, stages: template.pipeline!.stages.length, statuses: 0, sources: 0, automations: 0 });
    expect(second.added.fields).toBe(template.fields.length - 2);
    expect(await applied(org)).toEqual(["real_estate"]);
  });
});

describe("apply_industry_template and sample products (FLD-05, wave 2)", () => {
  const setProducts = (org: string, on: boolean, limits: Record<string, number> = {}) =>
    asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = feature_overrides || $2, limit_overrides = $3 where organization_id = $1", [
        org,
        JSON.stringify({ products: on }),
        JSON.stringify(limits),
      ]),
    );
  const sample = templateProducts("health");

  it("without the product catalog in the plan adds no products and reports nothing", async () => {
    const owner = await createUser("tpl-prod-off");
    const org = await createOrg(owner.id);
    await setProducts(org, false);
    const result = await apply(owner.id, org, "health");
    expect(result.added.products).toBe(0);
    expect(result.limits).toEqual([]);
    expect(await productRows(org)).toEqual([]);
    expect(await applied(org)).toEqual(["health"]);
  });

  it("with the catalog adds each missing sample product, taxable, price before VAT; a name in the catalog (archived too) is skipped", async () => {
    const owner = await createUser("tpl-prod-on");
    const org = await createOrg(owner.id);
    await setProducts(org, true);
    // the business already has one of the names, archived
    await asUser(owner.id, (q) => q("insert into public.products (organization_id, name, price_agorot) values ($1, $2, 1)", [org, sample[1].name]));
    await asAdmin((q) => q("update public.products set archived_at = now() where organization_id = $1", [org]));

    const result = await apply(owner.id, org, "health");
    expect(result.limits).toEqual([]);
    expect(result.added.products).toBe(sample.length - 1);
    const rows = await productRows(org);
    for (const p of sample.filter((_, i) => i !== 1)) {
      expect(rows.find((r) => r.name === p.name)).toEqual({
        name: p.name,
        kind: p.kind,
        price_agorot: String(p.price_agorot),
        price_includes_vat: false,
        vat_kind: "taxable",
        billing: p.billing,
        is_active: true,
      });
    }
    // the archived one is untouched, not added again
    expect(rows.filter((r) => r.name === sample[1].name)).toEqual([expect.objectContaining({ price_agorot: "1" })]);
    expect(await applied(org)).toEqual(["health"]);

    // again: nothing more
    expect((await apply(owner.id, org, "health")).added.products).toBe(0);
    expect(await productRows(org)).toHaveLength(sample.length);
  });

  it("the product quota of the plan is reported like any limit, and the template stays offered", async () => {
    const owner = await createUser("tpl-prod-quota");
    const org = await createOrg(owner.id);
    await setProducts(org, true, { max_products: 1 });
    const result = await apply(owner.id, org, "health");
    expect(result.added.products).toBe(1);
    expect(result.limits).toEqual(["limit:max_products"]);
    expect(await productRows(org)).toHaveLength(1);
    expect(await applied(org)).toEqual([]);
  });
});
