import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// PRM-01 follow-up (owner, 15 October 2026): a member with the import permission undoes their
// own import within 7 days; only records nobody changed since go to the recycle bin.
describe("undo of one's own import (PRM-01)", () => {
  let owner: U, holder: U, other: U, plain: U, viewer: U, owner2: U;
  let org: string, org2: string;

  const grant = (user: string, keys: string[]) =>
    asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, user, keys]));

  /** An import of `n` leads by `user`, finished; returns the job and the lead ids. */
  async function importLeads(user: string, n: number, o = org): Promise<{ job: string; leads: string[] }> {
    const job = await asUser(user, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'x.csv', 'skip') returning id", [o])).rows[0].id,
    );
    const leads: string[] = [];
    for (let i = 0; i < n; i++) leads.push(await insertLead(user, o, { full_name: `מיובא ${i}`, import_job_id: job }));
    await asUser(user, (q) => q("update public.import_jobs set status = 'done', created_count = $2 where id = $1", [job, n]));
    return { job, leads };
  }
  const undo = (user: string, job: string, o = org) =>
    asUser(user, async (q) => (await q<{ r: { done: number; kept: number } }>("select public.undo_own_import($1, $2) as r", [o, job])).rows[0].r);
  const inBin = (ids: string[]) => asAdmin((q) => count(q, "select 1 from public.leads where id = any($1) and deleted_at is not null", [ids]));
  const jobStatus = (job: string) => asAdmin(async (q) => (await q<{ s: string }>("select status as s from public.import_jobs where id = $1", [job])).rows[0].s);

  beforeAll(async () => {
    owner = await createUser("undo-owner");
    org = await createOrg(owner.id, "עסק ייבוא");
    holder = await addMember(org, owner.id, "member", "undo-holder");
    other = await addMember(org, owner.id, "member", "undo-other");
    plain = await addMember(org, owner.id, "member", "undo-plain");
    viewer = await addMember(org, owner.id, "viewer", "undo-viewer");
    owner2 = await createUser("undo-owner2");
    org2 = await createOrg(owner2.id, "עסק אחר");
    await grant(holder.id, ["import"]);
    await grant(other.id, ["import"]);
  });

  it("the holder undoes their own import; edited records stay and are counted", async () => {
    const { job, leads } = await importLeads(holder.id, 3);
    // someone works on one of them later (another transaction): it is no longer "unchanged"
    await asUser(owner.id, (q) => q("update public.leads set full_name = 'עודכן' where id = $1", [leads[0]]));
    expect(await undo(holder.id, job)).toEqual({ done: 2, kept: 1 });
    expect(await inBin(leads)).toBe(2);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1 and deleted_at is null", [leads[0]]))).toBe(1);
    expect(await jobStatus(job)).toBe("undone");
    // the move is in the audit log as the holder's
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = any($1) and action = 'trash' and actor_id = $2", [leads, holder.id]))).toBe(2);
    // once undone, not again
    expect((await pgError(undo(holder.id, job))).hint).toBe("import_undo:status");
  });

  it("a lead someone worked on after the import (a note, a task) stays and is counted, though its row did not change", async () => {
    const { job, leads } = await importLeads(holder.id, 3);
    await asUser(owner.id, async (q) => {
      await q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'דיברנו', $2)", [org, leads[0]]);
      await q("insert into public.tasks (organization_id, title, lead_id) values ($1, 'לחזור אליו', $2)", [org, leads[1]]);
    });
    // the note and the task did not touch the lead rows themselves
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = any($1) and updated_at = created_at", [leads.slice(0, 2)]))).toBe(2);
    expect(await undo(holder.id, job)).toEqual({ done: 1, kept: 2 });
    expect(await inBin([leads[2]])).toBe(1);
    expect(await inBin(leads.slice(0, 2))).toBe(0);
  });

  it("a contact someone put on a deal after the import stays and is counted", async () => {
    const job = await asUser(holder.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'd.csv', 'skip') returning id", [org])).rows[0].id,
    );
    const [onDeal, alone] = await asUser(holder.id, async (q) => {
      const a = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, import_job_id) values ($1, 'על עסקה', $2) returning id", [org, job])).rows[0].id;
      const b = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, import_job_id) values ($1, 'לבד', $2) returning id", [org, job])).rows[0].id;
      await q("update public.import_jobs set status = 'done' where id = $1", [job]);
      return [a, b];
    });
    const { pipelineId, stages } = await defaultPipeline(org);
    await asUser(owner.id, async (q) => {
      const deal = (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [org, pipelineId, stages[0].id])).rows[0].id;
      await q("insert into public.deal_contacts (organization_id, deal_id, contact_id) values ($1, $2, $3)", [org, deal, onDeal]);
    });
    expect(await undo(holder.id, job)).toEqual({ done: 1, kept: 1 });
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1 and deleted_at is null", [onDeal]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1 and deleted_at is not null", [alone]))).toBe(1);
  });

  it("a company a contact or deal from outside the import points at stays and is counted", async () => {
    const job = await asUser(holder.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'company', 'co.csv', 'skip') returning id", [org])).rows[0].id,
    );
    const [used, free] = await asUser(holder.id, async (q) => {
      const a = (await q<{ id: string }>("insert into public.companies (organization_id, name, import_job_id) values ($1, 'בשימוש', $2) returning id", [org, job])).rows[0].id;
      const b = (await q<{ id: string }>("insert into public.companies (organization_id, name, import_job_id) values ($1, 'פנויה', $2) returning id", [org, job])).rows[0].id;
      await q("update public.import_jobs set status = 'done' where id = $1", [job]);
      return [a, b];
    });
    // an existing contact moved onto the imported company later (the contact's own row is older)
    await asUser(owner.id, (q) => q("insert into public.contacts (organization_id, first_name) values ($1, 'ותיק')", [org]));
    await asUser(owner.id, (q) => q("update public.contacts set company_id = $2 where organization_id = $1 and first_name = 'ותיק'", [org, used]));
    expect(await undo(holder.id, job)).toEqual({ done: 1, kept: 1 });
    expect(await asAdmin((q) => count(q, "select 1 from public.companies where id = $1 and deleted_at is null", [used]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.companies where id = $1 and deleted_at is not null", [free]))).toBe(1);
  });

  it("a company of a contacts import stays while a kept contact of the same import points at it", async () => {
    const job = await asUser(holder.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'k.csv', 'skip') returning id", [org])).rows[0].id,
    );
    const [company, kept, gone] = await asUser(holder.id, async (q) => {
      const c = (await q<{ id: string }>("insert into public.companies (organization_id, name, import_job_id) values ($1, 'של הייבוא', $2) returning id", [org, job])).rows[0].id;
      const a = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, company_id, import_job_id) values ($1, 'נשאר', $2, $3) returning id", [org, c, job])).rows[0].id;
      const b = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, import_job_id) values ($1, 'הולך', $2) returning id", [org, job])).rows[0].id;
      await q("update public.import_jobs set status = 'done' where id = $1", [job]);
      return [c, a, b];
    });
    // someone edits the contact that works at the company: it stays, and so must its company
    await asUser(owner.id, (q) => q("update public.contacts set job_title = 'מנהלת' where id = $1", [kept]));
    expect(await undo(holder.id, job)).toEqual({ done: 1, kept: 2 });
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1 and deleted_at is null", [kept]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.companies where id = $1 and deleted_at is null", [company]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1 and deleted_at is not null", [gone]))).toBe(1);
  });

  it("a deal a follow-up deal from outside the import points at stays and is counted", async () => {
    const { pipelineId, stages } = await defaultPipeline(org);
    const job = await asUser(holder.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'deal', 'deals.csv', 'skip') returning id", [org])).rows[0].id,
    );
    const [followed, other] = await asUser(holder.id, async (q) => {
      const ins = async (name: string) =>
        (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id, import_job_id) values ($1, $2, $3, $4, $5) returning id", [org, name, pipelineId, stages[0].id, job])).rows[0].id;
      const a = await ins("עסקה עם המשך");
      const b = await ins("עסקה בודדת");
      await q("update public.import_jobs set status = 'done' where id = $1", [job]);
      return [a, b];
    });
    await asUser(owner.id, (q) =>
      q("insert into public.deals (organization_id, name, pipeline_id, stage_id, previous_deal_id) values ($1, 'המשך', $2, $3, $4)", [org, pipelineId, stages[0].id, followed]),
    );
    expect(await undo(holder.id, job)).toEqual({ done: 1, kept: 1 });
    expect(await asAdmin((q) => count(q, "select 1 from public.deals where id = $1 and deleted_at is null", [followed]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.deals where id = $1 and deleted_at is not null", [other]))).toBe(1);
  });

  it("the holder still cannot move records to the recycle bin by hand", async () => {
    const { leads } = await importLeads(holder.id, 1);
    expect((await pgError(asUser(holder.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [leads[0]])))).code).toBe("42501");
  });

  it("another member's import is refused, even for someone who holds the permission", async () => {
    const { job, leads } = await importLeads(other.id, 2);
    expect((await pgError(undo(holder.id, job))).code).toBe("P0002");
    expect(await inBin(leads)).toBe(0);
  });

  it("an import older than 7 days is refused", async () => {
    const { job, leads } = await importLeads(holder.id, 1);
    // created_at is kept by touch_row; set it the way a week passing would
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.import_jobs set created_at = now() - interval '8 days' where id = $1", [job]);
    });
    expect((await pgError(undo(holder.id, job))).hint).toBe("import_undo:expired");
    expect(await inBin(leads)).toBe(0);
  });

  it("a member without the permission is refused, and so is the same person once it is taken away", async () => {
    // plain gets the permission, imports, loses it
    await grant(plain.id, ["import"]);
    const { job, leads } = await importLeads(plain.id, 1);
    await grant(plain.id, []);
    expect((await pgError(undo(plain.id, job))).code).toBe("42501");
    expect(await inBin(leads)).toBe(0);
  });

  it("a viewer, and another business, are refused", async () => {
    const { job, leads } = await importLeads(holder.id, 1);
    // a viewer given the key behind the function's back, with an import of their own (made by hand: a
    // viewer cannot import), still holds nothing
    await asAdmin((q) => q("insert into public.member_permissions (organization_id, user_id, permissions) values ($1, $2, '{import}')", [org, viewer.id]));
    const viewerJob = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, status, created_by) values ($1, 'lead', 'v.csv', 'skip', 'done', $2) returning id", [org, viewer.id])).rows[0].id,
    );
    expect((await pgError(undo(viewer.id, viewerJob))).code).toBe("42501");
    expect((await pgError(undo(viewer.id, job))).code).toBe("P0002");
    // a job of another business, asked by its id under this business, or under its own
    const theirs = await asUser(owner2.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'y.csv', 'skip') returning id", [org2])).rows[0].id,
    );
    expect((await pgError(undo(holder.id, theirs))).code).toBe("P0002");
    expect((await pgError(undo(holder.id, job, org2))).code).toBe("P0002");
    expect((await pgError(undo(owner2.id, job, org2))).code).toBe("P0002");
    expect(await inBin(leads)).toBe(0);
  });

  it("owners and admins keep the existing undo (this function is for grant holders only)", async () => {
    const job = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'z.csv', 'skip') returning id", [org])).rows[0].id,
    );
    const lead = await insertLead(owner.id, org, { import_job_id: job });
    await asUser(owner.id, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
    expect((await pgError(undo(owner.id, job))).code).toBe("42501");
    await asUser(owner.id, async (q) => {
      expect((await q("update public.leads set deleted_at = now() where import_job_id = $1", [job])).rowCount).toBe(1);
    });
    expect(await inBin([lead])).toBe(1);
  });

  it("a contacts import takes its unchanged, unused companies along", async () => {
    const job = await asUser(holder.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'c.csv', 'skip') returning id", [org])).rows[0].id,
    );
    const [company, contact] = await asUser(holder.id, async (q) => {
      const c = (await q<{ id: string }>("insert into public.companies (organization_id, name, import_job_id) values ($1, 'חברה מיובאת', $2) returning id", [org, job])).rows[0].id;
      const k = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, company_id, import_job_id) values ($1, 'דנה', $2, $3) returning id", [org, c, job])).rows[0].id;
      await q("update public.import_jobs set status = 'done' where id = $1", [job]);
      return [c, k];
    });
    expect(await undo(holder.id, job)).toEqual({ done: 2, kept: 0 });
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1 and deleted_at is not null", [contact]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.companies where id = $1 and deleted_at is not null", [company]))).toBe(1);
  });
});
