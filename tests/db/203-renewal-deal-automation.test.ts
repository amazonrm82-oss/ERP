import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toDbRule } from "@/features/automations/convert";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";
import { TEMPLATES } from "@/features/automations/templates";

import { asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline } from "./helpers";

afterAll(closePool);

type U = { id: string };

/**
 * DEAL-08: the template "עסקת חידוש 30 יום לפני" is AUT-03's date trigger on deals.renewal_date with AUT-02's "create deal"
 * step. Built exactly as the settings page builds it (template -> toDbRule) and saved as a person, it makes one renewal deal
 * for the same customer, linked to the deal it renews, and a follow-up task, once per deal and renewal date.
 */
describe("renewal deal automation (DEAL-08)", () => {
  let owner: U;
  let org: string;
  let pipeline: string, openStage: string;

  const runDates = () =>
    asAdmin(async (q) => {
      await q("select set_config('app.date_trigger_hour', '0', true)");
      return (await q<{ n: number }>("select app.run_date_automations() as n")).rows[0].n;
    });

  beforeAll(async () => {
    owner = await createUser("ren-owner");
    org = await createOrg(owner.id, "עסק חידושים");
    await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    const main = await defaultPipeline(org);
    pipeline = main.pipelineId;
    openStage = main.stages.find((s) => s.kind === "open")!.id;
  });

  it("makes one renewal deal for the same customer, linked to the deal it renews, and a follow-up task", async () => {
    const template = TEMPLATES.find((t) => t.key === "renewal_deal_30d")!;
    const lookups: Lookups = {
      statuses: [],
      sources: [],
      tags: [],
      pipelines: [{ id: pipeline, name: "מכירות", stages: [{ id: openStage, name: "חדש", kind: "open" }] }],
      members: [],
      teams: [],
      reasons: [],
      fields: {},
    };
    const db = toDbRule(ruleSchema.parse(template.build!(lookups)), lookups);
    if (typeof db === "string") throw new Error(db);
    await asUser(owner.id, (q) =>
      q(
        `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, true)`,
        [org, db.name, db.entity_type, db.trigger_type, JSON.stringify(db.trigger_config), JSON.stringify(db.conditions), JSON.stringify(db.actions)],
      ),
    );

    const ids = await asAdmin(async (q) => {
      const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוחה', $2) returning id", [org, owner.id])).rows[0].id;
      const due = (
        await q<{ id: string }>(
          `insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id, billing_kind, recurring_amount_agorot, recurring_start_date, renewal_date)
           values ($1, 'מנוי שנתי', $2, $3, $4, $5, 'yearly', 120000, (now() at time zone 'Asia/Jerusalem')::date - 335, (now() at time zone 'Asia/Jerusalem')::date + 30)
           returning id`,
          [org, pipeline, openStage, owner.id, contact],
        )
      ).rows[0].id;
      const later = (
        await q<{ id: string }>(
          `insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, billing_kind, recurring_amount_agorot, recurring_start_date, renewal_date)
           values ($1, 'מנוי רחוק', $2, $3, $4, 'yearly', 120000, (now() at time zone 'Asia/Jerusalem')::date - 300, (now() at time zone 'Asia/Jerusalem')::date + 60)
           returning id`,
          [org, pipeline, openStage, owner.id],
        )
      ).rows[0].id;
      return { contact, due, later };
    });

    await runDates();
    const renewals = await asAdmin(async (q) =>
      (
        await q<{ name: string; previous_deal_id: string; contact_id: string | null; owner_id: string; pipeline_id: string }>(
          "select name, previous_deal_id, contact_id, owner_id, pipeline_id from public.deals where organization_id = $1 and previous_deal_id is not null",
          [org],
        )
      ).rows,
    );
    expect(renewals).toEqual([{ name: "חידוש: מנוי שנתי", previous_deal_id: ids.due, contact_id: ids.contact, owner_id: owner.id, pipeline_id: pipeline }]);
    const tasks = await asAdmin(async (q) =>
      (await q<{ title: string; task_type: string; owner_id: string }>("select title, task_type, owner_id from public.tasks where organization_id = $1 and deal_id = $2", [org, ids.due])).rows,
    );
    expect(tasks).toEqual([{ title: "לטפל בחידוש מנוי שנתי", task_type: "follow_up", owner_id: owner.id }]);

    // once per deal and renewal date
    await runDates();
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.deals where organization_id = $1 and previous_deal_id = $2", [org, ids.due])).rows[0].n)).toBe(1);
    // the renewal follows its deal: same process, the recurring revenue and lines for the next period, so the date rule
    // never fires again on the renewal itself (it renews a year later)
    expect(
      await asAdmin(async (q) =>
        (
          await q(
            `select r.billing_kind, r.recurring_amount_agorot::text as amount, r.recurring_start_date = d.renewal_date as starts_at_renewal,
                    r.renewal_date = (d.renewal_date + interval '1 year')::date as renews_a_year_later
               from public.deals r join public.deals d on d.id = r.previous_deal_id where r.previous_deal_id = $1`,
            [ids.due],
          )
        ).rows,
      ),
    ).toEqual([{ billing_kind: "yearly", amount: "120000", starts_at_renewal: true, renews_a_year_later: true }]);
    await runDates();
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.deals where organization_id = $1", [org])).rows[0].n)).toBe(3);
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.deals where organization_id = $1 and previous_deal_id = $2", [org, ids.later])).rows[0].n)).toBe(0);
  });
});
