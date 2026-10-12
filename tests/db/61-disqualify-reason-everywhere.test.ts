import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MERGE_COMPANIONS, MERGE_FIELDS, MERGE_TYPES } from "@/features/merge/fields";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// RVW-9: the "not relevant" reason follows the status in merges, automations and new leads.
describe("the not-relevant reason follows the status everywhere (RVW-9)", () => {
  let owner: U, member: U;
  let org: string, disqualified: string, open: string, other: string;

  beforeAll(async () => {
    owner = await createUser("dqe-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "dqe-member");
    const statuses = await asAdmin(async (q) =>
      (await q<{ id: string; kind: string; is_default: boolean }>("select id, kind, is_default from public.lead_statuses where organization_id = $1", [org])).rows,
    );
    disqualified = statuses.find((s) => s.kind === "disqualified")!.id;
    open = statuses.find((s) => s.kind === "open" && !s.is_default)!.id;
    other = statuses.find((s) => s.kind === "open" && s.is_default)!.id;
    // a list the business keeps (the defaults of 0076 replaced by two known names)
    await asUser(owner.id, (q) => q("delete from public.disqualify_reasons where organization_id = $1", [org]));
    await asUser(owner.id, (q) => q("insert into public.disqualify_reasons (organization_id, name) values ($1, 'קנה אצל מתחרה'), ($1, 'יקר מדי')", [org]));
  });

  const lead = (id: string) =>
    asAdmin(async (q) => (await q<{ status_id: string; disqualify_reason: string | null }>("select status_id, disqualify_reason from public.leads where id = $1", [id])).rows[0]);
  // as the lead's owner or the business owner; one row changed, or the test is wrong
  const disqualify = async (id: string, reason: string, as: U = owner) =>
    expect(
      await asUser(as.id, async (q) => (await q("update public.leads set status_id = $1, disqualify_reason = $2 where id = $3", [disqualified, reason, id])).rowCount),
    ).toBe(1);

  it("app.merge_columns matches the merge screen's fields and their companions", async () => {
    for (const type of MERGE_TYPES) {
      const db = await asAdmin(async (q) => (await q<{ cols: string[] }>("select app.merge_columns($1) as cols", [type])).rows[0].cols);
      const app = [...MERGE_FIELDS[type].map((f) => f.key), ...Object.values(MERGE_COMPANIONS[type]).flat()];
      expect([...db].sort()).toEqual([...app].sort());
    }
  });

  describe("merge", () => {
    const merge = (keep: string, dup: string, picks: Record<string, string>) =>
      asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, $4)", [org, keep, dup, JSON.stringify(picks)]));

    it("picking the duplicate's not-relevant status brings its reason", async () => {
      const keep = await insertLead(owner.id, org, { full_name: "שמור" });
      const dup = await insertLead(owner.id, org, { full_name: "כפול" });
      await disqualify(dup, "יקר מדי");
      // what the merge screen sends when the status is picked (MERGE_COMPANIONS)
      await merge(keep, dup, { status_id: "merge", disqualify_reason: "merge" });
      expect(await lead(keep)).toEqual({ status_id: disqualified, disqualify_reason: "יקר מדי" });
    });

    it("both not relevant: the picked status brings the duplicate's reason; not picked keeps the kept one's", async () => {
      const keep = await insertLead(owner.id, org, { full_name: "שמור" });
      const dup = await insertLead(owner.id, org, { full_name: "כפול" });
      await disqualify(keep, "קנה אצל מתחרה");
      await disqualify(dup, "יקר מדי");
      await merge(keep, dup, { status_id: "merge", disqualify_reason: "merge" });
      expect((await lead(keep)).disqualify_reason).toBe("יקר מדי");

      const keep2 = await insertLead(owner.id, org, { full_name: "שמור" });
      const dup2 = await insertLead(owner.id, org, { full_name: "כפול" });
      await disqualify(keep2, "קנה אצל מתחרה");
      await disqualify(dup2, "יקר מדי");
      await merge(keep2, dup2, { full_name: "merge" });
      expect((await lead(keep2)).disqualify_reason).toBe("קנה אצל מתחרה");
    });

    it("picking the duplicate's open status clears the kept lead's reason", async () => {
      const keep = await insertLead(owner.id, org, { full_name: "שמור" });
      const dup = await insertLead(owner.id, org, { full_name: "כפול", status_id: open });
      await disqualify(keep, "קנה אצל מתחרה");
      await merge(keep, dup, { status_id: "merge", disqualify_reason: "merge" });
      expect(await lead(keep)).toEqual({ status_id: open, disqualify_reason: null });
    });

    it("a status picked alone (a direct call) leaves no stale reason behind", async () => {
      const keep = await insertLead(owner.id, org, { full_name: "שמור" });
      const dup = await insertLead(owner.id, org, { full_name: "כפול" });
      await disqualify(dup, "יקר מדי");
      await merge(keep, dup, { status_id: "merge" });
      expect(await lead(keep)).toEqual({ status_id: disqualified, disqualify_reason: null });
    });
  });

  describe("automations and other server changes", () => {
    const runRule = async (statusId: string, leadId: string) => {
      const rule = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
             values ($1, 'סטטוס', 'lead', 'created', '{}', '[]', $2, false) returning id`,
            [org, JSON.stringify([{ type: "set_lead_status", status_id: statusId }])],
          )
        ).rows[0].id,
      );
      const result = await asUser(owner.id, async (q) => (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [rule, leadId])).rows[0].r);
      expect(result.status).toBe("success");
    };

    it("an automation that moves a lead out of not-relevant clears the reason", async () => {
      const id = await insertLead(member.id, org);
      await disqualify(id, "יקר מדי");
      await runRule(open, id);
      expect(await lead(id)).toEqual({ status_id: open, disqualify_reason: null });
    });

    it("an automation that moves a lead into not-relevant is allowed, with the reason left empty", async () => {
      const id = await insertLead(member.id, org);
      await runRule(disqualified, id);
      expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: null });
    });

    it("any server change of status clears a reason that does not belong to it; an old stale reason is not kept on entering", async () => {
      const id = await insertLead(member.id, org);
      await disqualify(id, "יקר מדי");
      await asAdmin((q) => q("update public.leads set status_id = $1 where id = $2", [other, id]));
      expect((await lead(id)).disqualify_reason).toBeNull();
      // a stale reason written before 0092 (simulated with the trigger off) is dropped on entering not-relevant
      await asAdmin(async (q) => {
        await q("alter table public.leads disable trigger leads_disqualify_reason");
        await q("update public.leads set disqualify_reason = 'ישן' where id = $1", [id]);
        await q("alter table public.leads enable trigger leads_disqualify_reason");
      });
      await asAdmin((q) => q("update public.leads set status_id = $1 where id = $2", [disqualified, id]));
      expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: null });
      // a server write that gives a reason keeps it
      await asAdmin((q) => q("update public.leads set disqualify_reason = 'סיבה מהשרת' where id = $1", [id]));
      expect((await lead(id)).disqualify_reason).toBe("סיבה מהשרת");
    });

    it("a person's change to an open status clears the reason even if one is sent", async () => {
      const id = await insertLead(member.id, org);
      await disqualify(id, "יקר מדי");
      await asUser(member.id, (q) => q("update public.leads set status_id = $1, disqualify_reason = 'יקר מדי' where id = $2", [open, id]));
      expect(await lead(id)).toEqual({ status_id: open, disqualify_reason: null });
    });
  });

  describe("new leads", () => {
    it("a person's new not-relevant lead needs a reason from the list", async () => {
      expect((await pgError(insertLead(member.id, org, { status_id: disqualified }))).hint).toBe("lead:disqualify_reason");
      expect((await pgError(insertLead(member.id, org, { status_id: disqualified, disqualify_reason: "סתם" }))).hint).toBe("lead:disqualify_reason");
      const id = await insertLead(member.id, org, { status_id: disqualified, disqualify_reason: "יקר מדי" });
      expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: "יקר מדי" });
    });

    it("a reason sent with an open status is dropped", async () => {
      const id = await insertLead(member.id, org, { status_id: open, disqualify_reason: "יקר מדי" });
      expect(await lead(id)).toEqual({ status_id: open, disqualify_reason: null });
    });

    it("an imported row is not refused without a reason, and gets no free-text reason (see 62 for the list)", async () => {
      const job = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'leads.csv', 'skip') returning id",
            [org],
          )
        ).rows[0].id,
      );
      const id = await insertLead(owner.id, org, { status_id: disqualified, import_job_id: job });
      expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: null });
      // and gets no reason, even one sent through the API
      const typed = await insertLead(owner.id, org, { status_id: disqualified, import_job_id: job, disqualify_reason: "טקסט חופשי" });
      expect(await lead(typed)).toEqual({ status_id: disqualified, disqualify_reason: null });
    });
  });
});
