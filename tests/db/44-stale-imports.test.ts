import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

const newJob = (userId: string, org: string) =>
  asUser(userId, async (q) =>
    (
      await q<{ id: string }>(
        "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows) values ($1, 'lead', 'f.csv', 'skip', 10) returning id",
        [org],
      )
    ).rows[0].id,
  );

// touch_row would set updated_at back to now(), so the clock is turned back with triggers off
const idleFor = (id: string, minutes: number) =>
  asAdmin(async (q) => {
    await q("set local session_replication_role = replica");
    await q("update public.import_jobs set updated_at = now() - make_interval(mins => $2) where id = $1", [id, minutes]);
  });

const job = (id: string) =>
  asAdmin(async (q) => (await q<{ status: string; created_count: number; finished_at: string | null }>("select status, created_count, finished_at from public.import_jobs where id = $1", [id])).rows[0]);

describe("an interrupted import is closed and can be undone (FXC-03)", () => {
  let owner: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("stale-owner");
    org = await createOrg(owner.id);
  });

  it("a job idle for 10 minutes becomes failed, with the records it created counted", async () => {
    const stale = await newJob(owner.id, org);
    await insertLead(owner.id, org, { full_name: "מהייבוא 1", import_job_id: stale });
    await insertLead(owner.id, org, { full_name: "מהייבוא 2", import_job_id: stale });
    const fresh = await newJob(owner.id, org);
    await idleFor(stale, 11);

    const closed = await asAdmin(async (q) => (await q<{ n: number }>("select app.fail_stale_imports() as n")).rows[0].n);
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(await job(stale)).toMatchObject({ status: "failed", created_count: 2 });
    expect((await job(stale)).finished_at).not.toBeNull();
    expect((await job(fresh)).status).toBe("running");
  });

  it("each chunk keeps its job alive; a closed job takes no more records", async () => {
    const live = await newJob(owner.id, org);
    await idleFor(live, 9);
    // what the chunk action does first
    const touched = await asUser(owner.id, (q) => q("update public.import_jobs set status = 'running' where id = $1 and status = 'running'", [live]));
    expect(touched.rowCount).toBe(1);
    await asAdmin((q) => q("select app.fail_stale_imports()"));
    expect((await job(live)).status).toBe("running");

    await idleFor(live, 20);
    await asAdmin((q) => q("select app.fail_stale_imports()"));
    const again = await asUser(owner.id, (q) => q("update public.import_jobs set status = 'running' where id = $1 and status = 'running'", [live]));
    expect(again.rowCount).toBe(0);
    expect((await pgError(insertLead(owner.id, org, { full_name: "מאוחר", import_job_id: live }))).code).toBe("42501");
  });

  it("only the server runs it", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("select app.fail_stale_imports()")))).code).toBe("42501");
  });
});
