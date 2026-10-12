import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// RVW-9, owner's answer of 12 October 2026: a lead import may carry the "not relevant" reason,
// from the organization's active list only; a row without one is imported with an empty reason.
describe("a lead import may carry a not-relevant reason from the list (RVW-9)", () => {
  let owner: U, member: U;
  let org: string, disqualified: string, open: string, job: string;

  beforeAll(async () => {
    owner = await createUser("dqi-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "dqi-member");
    const statuses = await asAdmin(async (q) =>
      (await q<{ id: string; kind: string; is_default: boolean }>("select id, kind, is_default from public.lead_statuses where organization_id = $1", [org])).rows,
    );
    disqualified = statuses.find((s) => s.kind === "disqualified")!.id;
    open = statuses.find((s) => s.kind === "open" && s.is_default)!.id;
    // the business's own list: two names, plus one it turned off
    await asUser(owner.id, (q) => q("delete from public.disqualify_reasons where organization_id = $1", [org]));
    await asUser(owner.id, (q) =>
      q("insert into public.disqualify_reasons (organization_id, name, is_active) values ($1, 'קנה אצל מתחרה', true), ($1, 'יקר מדי', true), ($1, 'ישן', false)", [org]),
    );
    job = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'leads.csv', 'update') returning id",
          [org],
        )
      ).rows[0].id,
    );
  });

  const lead = (id: string) =>
    asAdmin(async (q) => (await q<{ status_id: string; disqualify_reason: string | null }>("select status_id, disqualify_reason from public.leads where id = $1", [id])).rows[0]);
  const imported = (fields: Record<string, unknown>) => insertLead(owner.id, org, { import_job_id: job, ...fields });

  it("keeps a reason that is on the active list, stored trimmed as the list's name", async () => {
    const id = await imported({ status_id: disqualified, disqualify_reason: "יקר מדי" });
    expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: "יקר מדי" });
    const padded = await imported({ status_id: disqualified, disqualify_reason: "  קנה אצל מתחרה " });
    expect(await lead(padded)).toEqual({ status_id: disqualified, disqualify_reason: "קנה אצל מתחרה" });
  });

  it("imports a row without a reason with an empty reason", async () => {
    for (const reason of [null, "", "   "]) {
      const id = await imported({ status_id: disqualified, disqualify_reason: reason });
      expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: null });
    }
  });

  it("stores nothing for a reason that is not on the active list (free text, a turned-off name, another spelling)", async () => {
    for (const reason of ["טקסט חופשי", "ישן", "יקר  מדי"]) {
      const id = await imported({ status_id: disqualified, disqualify_reason: reason });
      expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: null });
    }
  });

  it("stores nothing while the list is empty", async () => {
    const other = await createUser("dqi-other");
    const emptyOrg = await createOrg(other.id);
    await asUser(other.id, (q) => q("update public.disqualify_reasons set is_active = false where organization_id = $1", [emptyOrg]));
    const status = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.lead_statuses where organization_id = $1 and kind = 'disqualified' limit 1", [emptyOrg])).rows[0].id,
    );
    const emptyJob = await asUser(other.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'x.csv', 'skip') returning id",
          [emptyOrg],
        )
      ).rows[0].id,
    );
    const id = await insertLead(other.id, emptyOrg, { status_id: status, import_job_id: emptyJob, disqualify_reason: "כל טקסט" });
    expect(await lead(id)).toEqual({ status_id: status, disqualify_reason: null });
  });

  it("drops a reason given with an open status", async () => {
    const id = await imported({ status_id: open, disqualify_reason: "יקר מדי" });
    expect(await lead(id)).toEqual({ status_id: open, disqualify_reason: null });
  });

  it("a person's own insert into not-relevant still needs a reason from the list", async () => {
    expect((await pgError(insertLead(member.id, org, { status_id: disqualified }))).hint).toBe("lead:disqualify_reason");
    expect((await pgError(insertLead(member.id, org, { status_id: disqualified, disqualify_reason: "ישן" }))).hint).toBe("lead:disqualify_reason");
    const id = await insertLead(member.id, org, { status_id: disqualified, disqualify_reason: "יקר מדי" });
    expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: "יקר מדי" });
  });

  it("an update (as an import in update mode sends it) is checked like a person's change", async () => {
    // an import's update carries no import job: moving a lead in needs a reason from the list
    const id = await imported({ status_id: open });
    const move = (reason: string | null) =>
      asUser(owner.id, (q) => q("update public.leads set status_id = $1, disqualify_reason = coalesce($2, disqualify_reason) where id = $3", [disqualified, reason, id]));
    expect((await pgError(move(null))).hint).toBe("lead:disqualify_reason");
    expect((await pgError(move("טקסט חופשי"))).hint).toBe("lead:disqualify_reason");
    await move("יקר מדי");
    expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: "יקר מדי" });
  });

  it("server writes are unchanged: a move into not-relevant leaves the reason empty, a given reason is kept", async () => {
    const id = await insertLead(owner.id, org, { status_id: open });
    await asAdmin((q) => q("update public.leads set status_id = $1 where id = $2", [disqualified, id]));
    expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: null });
    await asAdmin((q) => q("update public.leads set disqualify_reason = 'סיבה מהשרת' where id = $1", [id]));
    expect((await lead(id)).disqualify_reason).toBe("סיבה מהשרת");
  });
});
