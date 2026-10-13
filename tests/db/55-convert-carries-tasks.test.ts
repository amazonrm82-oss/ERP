import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

type Links = { lead_id: string | null; contact_id: string | null; deal_id: string | null };

/**
 * RVW-5: converting a lead moves its open tasks and its meetings to the new
 * contact and deal, like the timeline; done tasks stay with the lead.
 */
describe("conversion carries open tasks and meetings (RVW-5)", () => {
  let owner: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("cct-owner");
    org = await createOrg(owner.id);
  });

  const task = (lead: string, title: string, status = "open", deal: string | null = null) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.tasks (organization_id, title, due_at, lead_id, deal_id, status) values ($1, $2, now() + interval '1 day', $3, $4, $5) returning id",
          [org, title, lead, deal, status],
        )
      ).rows[0].id,
    );
  const meeting = (lead: string, status: string, startHours: number) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.meetings (organization_id, title, starts_at, ends_at, status, lead_id)
           values ($1, 'פגישה', now() + make_interval(hours => $2::int), now() + make_interval(hours => $2::int + 1), $3, $4) returning id`,
          [org, startHours, status, lead],
        )
      ).rows[0].id,
    );
  const links = (table: "tasks" | "meetings", id: string) =>
    asAdmin(async (q) => (await q<Links>(`select lead_id, contact_id, deal_id from public.${table} where id = $1`, [id])).rows[0]);
  const convert = (lead: string, withDeal = true) =>
    asUser(owner.id, async (q) =>
      (await q<{ r: { contact_id: string; deal_id: string | null } }>("select public.convert_lead($1, $2, null, 0) as r", [lead, withDeal])).rows[0].r,
    );

  it("open tasks get the contact and the deal; done ones and ones in the recycle bin stay; a link a task had is kept", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד עם משימות" });
    const open = await task(lead, "לחזור אליו מחר");
    const done = await task(lead, "שיחה ראשונה", "done");
    const trashed = await task(lead, "בסל");
    await asUser(owner.id, (q) => q("update public.tasks set deleted_at = now() where id = $1", [trashed]));

    const result = await convert(lead);
    expect(await links("tasks", open)).toEqual({ lead_id: lead, contact_id: result.contact_id, deal_id: result.deal_id });
    expect(await links("tasks", done)).toEqual({ lead_id: lead, contact_id: null, deal_id: null });
    expect(await links("tasks", trashed)).toEqual({ lead_id: lead, contact_id: null, deal_id: null });
  });

  it("without a deal, open tasks get the contact only", async () => {
    const lead = await insertLead(owner.id, org);
    const open = await task(lead, "לשלוח מייל");
    const result = await convert(lead, false);
    expect(result.deal_id).toBeNull();
    expect(await links("tasks", open)).toEqual({ lead_id: lead, contact_id: result.contact_id, deal_id: null });
  });

  it("every meeting of the lead gets the contact and the deal", async () => {
    const lead = await insertLead(owner.id, org);
    const ahead = await meeting(lead, "planned", 24);
    const past = await meeting(lead, "held", -48);
    const result = await convert(lead);
    for (const id of [ahead, past]) {
      expect(await links("meetings", id)).toEqual({ lead_id: lead, contact_id: result.contact_id, deal_id: result.deal_id });
    }
  });

  it("without a deal, every meeting gets the contact only; a contact it already had is kept", async () => {
    const lead = await insertLead(owner.id, org);
    const plain = await meeting(lead, "planned", 30);
    const other = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'קיים') returning id", [org])).rows[0].id,
    );
    const linked = await meeting(lead, "planned", 40);
    await asUser(owner.id, (q) => q("update public.meetings set contact_id = $2 where id = $1", [linked, other]));
    const result = await convert(lead, false);
    expect(result.deal_id).toBeNull();
    expect(await links("meetings", plain)).toEqual({ lead_id: lead, contact_id: result.contact_id, deal_id: null });
    expect(await links("meetings", linked)).toEqual({ lead_id: lead, contact_id: other, deal_id: null });
  });

  it("the new deal is not stuck and the contact's card shows the next task", async () => {
    const lead = await insertLead(owner.id, org);
    const open = await task(lead, "לחזור אליו מחר");
    const result = await convert(lead);
    const stuck = await asUser(owner.id, async (q) => (await q<{ r: { id: string }[] }>("select public.report_stuck_deals($1) as r", [org])).rows[0].r);
    expect(stuck.map((row) => row.id)).not.toContain(result.deal_id);
    const summary = await asUser(owner.id, async (q) =>
      (await q<{ s: { next_task: { id: string } | null; open_tasks: number } }>("select public.record_summary($1, 'contact', $2) as s", [org, result.contact_id])).rows[0].s,
    );
    expect(summary.next_task?.id).toBe(open);
    expect(summary.open_tasks).toBe(1);
  });

  it("the moves start no automation", async () => {
    const lead = await insertLead(owner.id, org);
    const open = await task(lead, "משימה");
    await convert(lead);
    const events = await asAdmin(async (q) =>
      (await q<{ origin: string | null }>("select payload ->> 'origin' as origin from public.outbox_events where entity_id = $1 and event_type = 'task.updated'", [open])).rows,
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.origin === "automation")).toBe(true);
    // and the flag is back off for the rest of the transaction's writes
    const another = await insertLead(owner.id, org);
    const setting = await asUser(owner.id, async (q) => {
      await q("select public.convert_lead($1, true, null, 0)", [another]);
      return (await q<{ v: string | null }>("select current_setting('app.automation_running', true) as v")).rows[0].v;
    });
    expect(setting ?? "").not.toBe("on");
  });
});
