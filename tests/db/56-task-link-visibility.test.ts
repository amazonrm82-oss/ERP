import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// RVW-10: a task may link only records the user can see (as activities since 0060 and
// meetings since 0053). On update only a link that is set or changed is checked, so a
// task handed over on a record its assignee cannot see still works for the assignee.
describe("a task links only visible records (RVW-10)", () => {
  let owner: U, m1: U, m2: U, stranger: U;
  let org: string, otherOrg: string;
  let leadM1: string, leadM2: string, contactM1: string, contactM2: string, companyM2: string, dealM1: string, dealM2: string, strangerLead: string;

  const newRecord = (user: U, sql: string, params: unknown[]) =>
    asUser(user.id, async (q) => (await q<{ id: string }>(sql, params)).rows[0].id);
  const newDeal = async (user: U, name: string) => {
    const { pipelineId, stages } = await defaultPipeline(org);
    return newRecord(user, "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, $2, $3, $4) returning id", [
      org,
      name,
      pipelineId,
      stages[0].id,
    ]);
  };

  beforeAll(async () => {
    owner = await createUser("tlink-owner");
    org = await createOrg(owner.id);
    m1 = await addMember(org, owner.id, "member", "tlink-m1");
    m2 = await addMember(org, owner.id, "member", "tlink-m2");
    stranger = await createUser("tlink-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    // 'own': a member sees only their own records
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    leadM1 = await insertLead(m1.id, org, { full_name: "ליד של m1" });
    leadM2 = await insertLead(m2.id, org, { full_name: "ליד של m2" });
    contactM1 = await newRecord(m1, "insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org]);
    contactM2 = await newRecord(m2, "insert into public.contacts (organization_id, first_name) values ($1, 'רון') returning id", [org]);
    companyM2 = await newRecord(m2, "insert into public.companies (organization_id, name) values ($1, 'חברה של m2') returning id", [org]);
    dealM1 = await newDeal(m1, "עסקה של m1");
    dealM2 = await newDeal(m2, "עסקה של m2");
    strangerLead = await insertLead(stranger.id, otherOrg);
  });

  const insert = (user: U, orgId: string, links: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const row = { ...links, ...extra };
    const columns = Object.keys(row);
    return asUser(user.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.tasks (organization_id, title${columns.map((c) => `, ${c}`).join("")}) values ($1, 'משימה'${columns.map((_, i) => `, $${i + 2}`).join("")}) returning id`,
          [orgId, ...Object.values(row)],
        )
      ).rows[0].id,
    );
  };
  const update = (user: U, task: string, set: string, params: unknown[] = []) =>
    asUser(user.id, async (q) => (await q(`update public.tasks set ${set} where id = $1`, [task, ...params])).rowCount);
  const linkOf = (task: string) =>
    asAdmin(async (q) => (await q<{ lead_id: string | null; deal_id: string | null; status: string }>("select lead_id, deal_id, status from public.tasks where id = $1", [task])).rows[0]);
  const tasksOn = (lead: string) => asAdmin((q) => count(q, "select 1 from public.tasks where lead_id = $1", [lead]));

  it("a member still adds a task with no link, or on their own lead, contact and deal", async () => {
    await insert(m1, org, {});
    await insert(m1, org, { lead_id: leadM1 });
    await insert(m1, org, { lead_id: leadM1, contact_id: contactM1, deal_id: dealM1 });
    expect(await tasksOn(leadM1)).toBe(2);
  });

  it("a member cannot add a task on a record they cannot see, alone or next to their own", async () => {
    expect(await asUser(m1.id, (q) => count(q, "select 1 from public.leads where id = $1", [leadM2]))).toBe(0);
    const forbidden: Record<string, string>[] = [
      { lead_id: leadM2 },
      { lead_id: leadM2, contact_id: contactM1 },
      { contact_id: contactM2 },
      { company_id: companyM2 },
      { deal_id: dealM2 },
      { lead_id: leadM1, deal_id: dealM2 },
    ];
    for (const links of forbidden) {
      const error = await pgError(insert(m1, org, links));
      expect(error.code).toBe("42501");
      expect(error.message).toMatch(/row-level security/);
    }
    expect(await tasksOn(leadM2)).toBe(0);
  });

  it("a member cannot move their task onto a record they cannot see, but may onto their own", async () => {
    const task = await insert(m1, org, { lead_id: leadM1 });
    for (const set of ["lead_id = $2", "contact_id = $2", "company_id = $2", "deal_id = $2"]) {
      const target = { "lead_id = $2": leadM2, "contact_id = $2": contactM2, "company_id = $2": companyM2, "deal_id = $2": dealM2 }[set];
      expect((await pgError(update(m1, task, set, [target]))).code).toBe("42501");
    }
    expect((await linkOf(task)).lead_id).toBe(leadM1);
    expect(await update(m1, task, "deal_id = $2", [dealM1])).toBe(1);
    expect(await update(m1, task, "lead_id = null")).toBe(1);
    expect(await linkOf(task)).toMatchObject({ lead_id: null, deal_id: dealM1 });
  });

  it("whoever sees the record may link it, and hand the task to someone who does not", async () => {
    // the owner sees everything and hands m1 a task on m2's lead
    const handed = await insert(owner, org, { lead_id: leadM2 }, { owner_id: m1.id });
    // m1 sees the task, not the lead, and still works the task: the unchanged link is not checked
    expect(await asUser(m1.id, (q) => count(q, "select 1 from public.tasks where id = $1", [handed]))).toBe(1);
    expect(await update(m1, handed, "title = 'להתקשר שוב'")).toBe(1);
    expect(await update(m1, handed, "status = 'done'")).toBe(1);
    // writing the same link back is no change either
    expect(await update(m1, handed, "lead_id = $2", [leadM2])).toBe(1);
    expect(await linkOf(handed)).toMatchObject({ lead_id: leadM2, status: "done" });
    // the owner may move a task onto any record
    const own = await insert(m1, org, {});
    expect(await update(owner, own, "deal_id = $2", [dealM2])).toBe(1);
  });

  it("server writers are not affected: a recurring task on a hidden record comes back, conversion carries tasks", async () => {
    // the next task of a series is created by the database (security definer) for m1, on m2's lead
    const series = await insert(owner, org, { lead_id: leadM2 }, { owner_id: m1.id, due_at: "2031-01-06 09:00+02", recurrence: JSON.stringify({ kind: "daily" }) });
    expect(await update(m1, series, "status = 'done'")).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where recurrence_source_id = $1 and lead_id = $2 and owner_id = $3", [series, leadM2, m1.id]))).toBe(1);

    // convert_lead (security definer) links the lead's open task to the new contact and deal
    const toConvert = await insertLead(m1.id, org, { full_name: "ליד להמרה" });
    const open = await insert(m1, org, { lead_id: toConvert });
    const result = await asUser(m1.id, async (q) => (await q<{ r: { contact_id: string; deal_id: string } }>("select public.convert_lead($1, true, null, 0) as r", [toConvert])).rows[0].r);
    expect(await linkOf(open)).toMatchObject({ lead_id: toConvert, deal_id: result.deal_id });
  });

  it("another organization cannot link its task to our records", async () => {
    expect((await pgError(insert(stranger, org, { lead_id: leadM1 }))).code).toBe("42501");
    // the composite foreign key or the policy refuses a lead of another organization
    expect((await pgError(insert(stranger, otherOrg, { lead_id: leadM1 }))).code).toMatch(/^(42501|23503)$/);
    const theirs = await insert(stranger, otherOrg, { lead_id: strangerLead });
    expect((await pgError(update(stranger, theirs, "contact_id = $2", [contactM1]))).code).toMatch(/^(42501|23503)$/);
    expect(await tasksOn(leadM1)).toBe(2);
  });
});
