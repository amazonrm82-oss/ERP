import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// RVW-23: every quota or cap trigger starts with the outsider guard. A person who sends another
// business's organization_id gets RLS's plain 42501, never that business's quota hint, even when the
// business is at its cap. The business's own owner still gets the hint (the cap is live).
describe("quota triggers answer an outsider with the plain refusal (RVW-23)", () => {
  let owner: U, outsider: U;
  let org: string;
  let lead: string;

  const fill = (table: string, cap: number, extra = "", values = "") =>
    asAdmin((q) =>
      q(
        `insert into public.${table} (organization_id, name${extra})
         select $1, 'מילוי ' || g${values} from generate_series(1, greatest(0, $2 - (select count(*) from public.${table} where organization_id = $1)::int)) g`,
        [org, cap],
      ),
    );
  const limits = (json: Record<string, number>) =>
    asAdmin((q) => q("update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || $2::jsonb where organization_id = $1", [org, JSON.stringify(json)]));

  beforeAll(async () => {
    owner = await createUser("owner");
    outsider = await createUser("outsider");
    org = await createOrg(owner.id);
    await createOrg(outsider.id, "עסק של הזר");
    lead = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.leads (organization_id, status_id, full_name) select $1, s.id, 'ליד' from public.lead_statuses s where s.organization_id = $1 order by s.position limit 1 returning id", [org])).rows[0].id,
    );
  });

  // every case is checked and reported together, so one run names each trigger that lacks the guard
  async function expectGuarded(sql: string, params: unknown[], hint: string) {
    const own = await pgError(asUser(owner.id, (q) => q(sql, params)));
    const other = await pgError(asUser(outsider.id, (q) => q(sql, params)));
    expect.soft({ sql, own: own.hint, outsider: other.code, outsiderHint: other.hint ?? null }).toEqual({
      sql,
      own: hint,
      outsider: "42501",
      outsiderHint: null,
    });
  }

  it("managed lists at their cap", async () => {
    await fill("disqualify_reasons", 50);
    await expectGuarded("insert into public.disqualify_reasons (organization_id, name) values ($1, 'x')", [org], "reasons:max");
    await fill("deal_loss_reasons", 50);
    await expectGuarded("insert into public.deal_loss_reasons (organization_id, name) values ($1, 'x')", [org], "reasons:max");
    await fill("whatsapp_templates", 50, ", body", ", 'גוף'");
    await expectGuarded("insert into public.whatsapp_templates (organization_id, name, body) values ($1, 'x', 'x')", [org], "whatsapp_templates:max");
    await asAdmin((q) =>
      q(
        `insert into public.record_type_options (organization_id, object_type, name)
         select $1, 'company', 'מילוי ' || g from generate_series(1, greatest(0, 50 - (select count(*) from public.record_type_options where organization_id = $1 and object_type = 'company')::int)) g`,
        [org],
      ),
    );
    await expectGuarded("insert into public.record_type_options (organization_id, object_type, name) values ($1, 'company', 'x')", [org], "record_types:max");
    await fill("product_units", 50);
    await expectGuarded("insert into public.product_units (organization_id, name) values ($1, 'x')", [org], "product_units:max");
    await fill("product_categories", 200);
    await expectGuarded("insert into public.product_categories (organization_id, name) values ($1, 'x')", [org], "product_categories:max");
  });

  it("plan limits: pipelines, custom fields, forms, active automations, storage", async () => {
    await limits({ max_pipelines: 0, max_custom_fields_per_object: 0, max_forms: 0, max_active_automations: 0, storage_gb: 0 });
    await expectGuarded("insert into public.pipelines (organization_id, name) values ($1, 'x')", [org], "limit:max_pipelines");
    await expectGuarded(
      "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'deal', 'x', 'x', 'text')",
      [org],
      "limit:max_custom_fields_per_object",
    );
    await expectGuarded("insert into public.forms (organization_id, name) values ($1, 'x')", [org], "limit:max_forms");
    await expectGuarded(
      "insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'x', 'lead', 'created', '[{\"type\":\"notify\"}]', true)",
      [org],
      "limit:max_active_automations",
    );
    await expectGuarded(
      "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'x.pdf', 'application/pdf', 1000)",
      [org, lead],
      "limit:storage_gb",
    );
  });

  it("a member's leaves at their cap", async () => {
    // 100 current or future leaves of the owner; one more is refused for the owner, plainly for the outsider
    await asAdmin((q) =>
      q(
        `insert into public.member_leaves (organization_id, user_id, starts_on, ends_on)
         select $1, $2, d, d from (select (current_date + 10 + g * 2) as d from generate_series(1, 100) g) s`,
        [org, owner.id],
      ),
    );
    const sql = "insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, current_date + 300, current_date + 300)";
    await expectGuarded(sql, [org, owner.id], "member_leaves:max");
  });
});
