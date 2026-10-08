import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asUser, closePool, count, createOrg, createUser, defaultLeadStatus } from "./helpers";

afterAll(closePool);

describe("scheduled automations reach every record, oldest first (FXD-02)", () => {
  let owner: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("paging-owner");
    org = await createOrg(owner.id);
    // 450 dormant leads (well past the old 200 cap), created 10 to 459 days ago
    const status = await defaultLeadStatus(org);
    await asAdmin((q) =>
      q(
        `insert into public.leads (organization_id, full_name, owner_id, status_id, created_at)
         select $1, 'רדום ' || g, $2, $3, now() - make_interval(days => 9 + g) from generate_series(1, 450) g`,
        [org, owner.id, status],
      ),
    );
  });

  const rule = (conditions: unknown[]) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions)
           values ($1, 'רדומים', 'lead', 'no_activity', '{"days": 3}', $2, '[{"type": "notify", "to": "owner", "title": "אין פעילות: {{name}}"}]') returning id`,
          [org, JSON.stringify(conditions)],
        )
      ).rows[0].id,
    );
  const runs = (automationId: string) => asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1", [automationId]));

  it("every dormant lead is handled in one run, and a second run adds nothing", async () => {
    const id = await rule([]);
    await asAdmin((q) => q("select app.run_scheduled_automations()"));
    expect(await runs(id)).toBe(450);
    await asAdmin((q) => q("select app.run_scheduled_automations()"));
    expect(await runs(id)).toBe(450);
    await asAdmin((q) => q("update public.automations set is_active = false where id = $1", [id]));
  });

  it("records that do not match the conditions do not hide the ones behind them", async () => {
    // only the newest 50 match; the 400 older ones fail the condition and leave no run behind
    await asAdmin((q) => q("update public.leads set campaign = 'קיץ' where organization_id = $1 and created_at > now() - interval '60 days'", [org]));
    const id = await rule([{ field: "campaign", op: "eq", value: "קיץ" }]);
    await asAdmin((q) => q("select app.run_scheduled_automations()"));
    expect(await runs(id)).toBe(50);
  });
});
