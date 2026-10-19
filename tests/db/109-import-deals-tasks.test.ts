import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

const newJob = (userId: string, org: string, entity: string) =>
  asUser(userId, async (q) =>
    (
      await q<{ id: string }>(
        "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows) values ($1, $2, 'file.xlsx', 'create', 10) returning id",
        [org, entity],
      )
    ).rows[0].id,
  );

const insertRow = (table: "deals" | "tasks", userId: string, org: string, values: Record<string, unknown>) =>
  asUser(userId, async (q) => {
    const keys = Object.keys(values);
    const sql = `insert into public.${table} (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
    return (await q<{ id: string }>(sql, [org, ...keys.map((k) => values[k])])).rows[0].id;
  });

const finish = (userId: string, job: string) => asUser(userId, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));

// IMP-03: deals and tasks imported from a file remember their import, like leads (0012) and products (0159).
describe("deal and task import (IMP-03)", () => {
  let owner: U, admin: U, manager: U, member: U, owner2: U;
  let org: string, other: string;
  let pipeline: { pipelineId: string; stages: { id: string; kind: string }[] };
  let openStage: string, wonStage: string;

  const deal = (userId: string, values: Record<string, unknown>, o = org) =>
    insertRow("deals", userId, o, { name: "עסקה", pipeline_id: pipeline.pipelineId, stage_id: openStage, ...values });
  const task = (userId: string, values: Record<string, unknown>, o = org) => insertRow("tasks", userId, o, { title: "משימה", ...values });

  beforeAll(async () => {
    owner = await createUser("idt-owner");
    owner2 = await createUser("idt-owner2");
    org = await createOrg(owner.id);
    other = await createOrg(owner2.id, "עסק אחר");
    admin = await addMember(org, owner.id, "admin", "idt-admin");
    manager = await addMember(org, owner.id, "manager", "idt-manager");
    member = await addMember(org, owner.id, "member", "idt-member");
    pipeline = await defaultPipeline(org);
    openStage = pipeline.stages.find((s) => s.kind === "open")!.id;
    wonStage = pipeline.stages.find((s) => s.kind === "won")!.id;
  });

  it("owners, admins and team managers may open a deal or task import; members and viewers may not", async () => {
    for (const entity of ["deal", "task"]) {
      for (const user of [owner, admin, manager]) expect(await newJob(user.id, org, entity)).toBeTruthy();
      expect((await pgError(newJob(member.id, org, entity))).code).toBe("42501");
    }
    const viewer = await addMember(org, owner.id, "viewer", "idt-viewer");
    expect((await pgError(newJob(viewer.id, org, "deal"))).code).toBe("42501");
  });

  it("a deal or task may carry only a running import of the same user and type, set once", async () => {
    for (const [entity, insert, table] of [
      ["deal", deal, "deals"],
      ["task", task, "tasks"],
    ] as const) {
      const job = await newJob(owner.id, org, entity);
      const id = await insert(owner.id, { import_job_id: job });
      expect(await asAdmin(async (q) => (await q<{ j: string }>(`select import_job_id as j from public.${table} where id = $1`, [id])).rows[0].j)).toBe(job);

      // another user's job, a job of another object, a finished job, a job of another organization
      const adminJob = await newJob(admin.id, org, entity);
      expect((await pgError(insert(owner.id, { import_job_id: adminJob }))).code).toBe("42501");
      const leadJob = await newJob(owner.id, org, "lead");
      expect((await pgError(insert(owner.id, { import_job_id: leadJob }))).code).toBe("42501");
      const finished = await newJob(owner.id, org, entity);
      await finish(owner.id, finished);
      expect((await pgError(insert(owner.id, { import_job_id: finished }))).code).toBe("42501");
      const otherJob = await newJob(owner2.id, other, entity);
      expect((await pgError(insert(owner.id, { import_job_id: otherJob }))).code).toMatch(/^(42501|23503)$/);

      // never changed afterwards: tasks have no update grant on the column, the guard refuses on deals
      const plain = await insert(owner.id, {});
      const running = await newJob(owner.id, org, entity);
      expect((await pgError(asUser(owner.id, (q) => q(`update public.${table} set import_job_id = $1 where id = $2`, [running, plain])))).code).toBe("42501");
      expect((await pgError(asUser(owner.id, (q) => q(`update public.${table} set import_job_id = null where id = $1`, [id])))).code).toBe("42501");
    }
  });

  it("tasks.import_job_id is granted for insert only", async () => {
    const grants = await asAdmin(
      async (q) =>
        (
          await q<{ privilege_type: string }>(
            "select privilege_type from information_schema.column_privileges where table_schema = 'public' and table_name = 'tasks' and column_name = 'import_job_id' and grantee = 'authenticated' order by 1",
          )
        ).rows.map((r) => r.privilege_type),
    );
    expect(grants).toEqual(["INSERT", "SELECT"]);
  });

  it("imported deals and tasks start no automation and send no assignment notification", async () => {
    for (const entity of ["deal", "task"]) {
      await asUser(owner.id, (q) =>
        q("insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, $2, $3, 'created', $4)", [
          org,
          `חדש ${entity}`,
          entity,
          JSON.stringify([{ type: "notify", to: "owner", title: "נוצר: {{name}}" }]),
        ]),
      );
    }
    const dealJob = await newJob(owner.id, org, "deal");
    const taskJob = await newJob(owner.id, org, "task");
    const importedDeal = await deal(owner.id, { name: "מיובאת", owner_id: member.id, import_job_id: dealJob });
    const typedDeal = await deal(owner.id, { name: "הוקלדה", owner_id: member.id });
    const importedTask = await task(owner.id, { title: "מיובאת", owner_id: member.id, import_job_id: taskJob });
    const typedTask = await task(owner.id, { title: "הוקלדה", owner_id: member.id });

    await asAdmin(async (q) => {
      for (const id of [importedDeal, importedTask]) {
        expect((await q<{ origin: string | null }>("select payload ->> 'origin' as origin from public.outbox_events where entity_id = $1", [id])).rows[0].origin).toBe("import");
      }
      for (const id of [typedDeal, typedTask]) {
        expect((await q<{ origin: string | null }>("select payload ->> 'origin' as origin from public.outbox_events where entity_id = $1", [id])).rows[0].origin).toBeNull();
      }
    });
    // process_outbox is shared by every test file and claims events with SKIP LOCKED: another file's run may hold this test's
    // events for a moment, so run it until both typed events are processed (the assertions below are unchanged)
    for (let i = 0; i < 50; i += 1) {
      await asAdmin((q) => q("select app.process_outbox(5000)"));
      const left = await asAdmin((q) => count(q, "select 1 from public.outbox_events where entity_id = any($1) and processed_at is null", [[typedDeal, typedTask]]));
      if (left === 0) break;
      await asAdmin((q) => q("select pg_sleep(0.1)"));
    }
    await asAdmin(async (q) => {
      for (const id of [importedDeal, importedTask]) {
        expect(await count(q, "select 1 from public.automation_runs where entity_id = $1", [id])).toBe(0);
        expect(await count(q, "select 1 from public.notifications where entity_id = $1", [id])).toBe(0);
      }
      for (const id of [typedDeal, typedTask]) {
        expect(await count(q, "select 1 from public.automation_runs where entity_id = $1", [id])).toBe(1);
        expect(await count(q, "select 1 from public.notifications where entity_id = $1 and type = 'assigned'", [id])).toBe(1);
      }
    });
  });

  it("an imported won deal keeps its past close date, gets now() without one, and refuses a future one (DEAL-04)", async () => {
    const job = await newJob(owner.id, org, "deal");
    const past = "2026-03-01T10:00:00.000Z";
    const kept = await deal(owner.id, { stage_id: wonStage, closed_at: past, import_job_id: job });
    const stamped = await deal(owner.id, { stage_id: wonStage, import_job_id: job });
    const open = await deal(owner.id, { closed_at: past, import_job_id: job });
    await asAdmin(async (q) => {
      const row = async (id: string) =>
        (await q<{ status: string; closed_at: Date | null }>("select status, closed_at from public.deals where id = $1", [id])).rows[0];
      expect(await row(kept)).toMatchObject({ status: "won", closed_at: new Date(past) });
      const now = await row(stamped);
      expect(now.status).toBe("won");
      expect(Math.abs(now.closed_at!.getTime() - Date.now())).toBeLessThan(60_000);
      expect((await row(open)).closed_at).toBeNull();
    });
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect((await pgError(deal(owner.id, { stage_id: wonStage, closed_at: future, import_job_id: job }))).hint).toBe("deal:closed_at");
  });

  it("a stage of another pipeline is refused (no new stage is made)", async () => {
    const otherPipeline = await defaultPipeline(other);
    const job = await newJob(owner.id, org, "deal");
    expect((await pgError(deal(owner.id, { stage_id: otherPipeline.stages[0].id, import_job_id: job }))).code).toBe("23503");
  });

  it("an imported task may link only records the importer can read", async () => {
    // visibility 'own': a manager without a team reads only their own records
    const org3Owner = await createUser("idt-o3");
    const org3 = await createOrg(org3Owner.id, "עסק שלישי");
    const mgr = await addMember(org3, org3Owner.id, "manager", "idt-o3-manager");
    const mem = await addMember(org3, org3Owner.id, "member", "idt-o3-member");
    await asUser(org3Owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org3]));
    const hidden = await insertLead(mem.id, org3, { full_name: "של חבר צוות", owner_id: mem.id });
    const mine = await insertLead(mgr.id, org3, { full_name: "שלי", owner_id: mgr.id });
    const job = await newJob(mgr.id, org3, "task");
    expect((await pgError(task(mgr.id, { lead_id: hidden, import_job_id: job }, org3))).code).toBe("42501");
    expect(await task(mgr.id, { lead_id: mine, import_job_id: job }, org3)).toBeTruthy();

    // a record of another organization cannot be linked at all (composite key or the read check)
    const foreignLead = await insertLead(owner2.id, other, { full_name: "של עסק אחר" });
    const ownJob = await newJob(owner.id, org, "task");
    expect((await pgError(task(owner.id, { lead_id: foreignLead, import_job_id: ownJob }))).code).toMatch(/^(42501|23503)$/);
  });

  it("a stale deal or task import is closed with the records it created counted", async () => {
    for (const [entity, insert] of [
      ["deal", deal],
      ["task", task],
    ] as const) {
      const job = await newJob(owner.id, org, entity);
      await insert(owner.id, { import_job_id: job });
      await insert(owner.id, { import_job_id: job });
      await asAdmin(async (q) => {
        await q("set local session_replication_role = replica");
        await q("update public.import_jobs set updated_at = now() - interval '11 minutes' where id = $1", [job]);
      });
      await asAdmin((q) => q("select app.fail_stale_imports()"));
      expect(await asAdmin(async (q) => (await q("select status, created_count from public.import_jobs where id = $1", [job])).rows[0])).toEqual({
        status: "failed",
        created_count: 2,
      });
    }
  });

  it("undo moves exactly the imported deals and tasks out of sight; a member cannot", async () => {
    for (const [entity, insert, table] of [
      ["deal", deal, "deals"],
      ["task", task, "tasks"],
    ] as const) {
      const job = await newJob(owner.id, org, entity);
      await insert(owner.id, { import_job_id: job });
      await insert(owner.id, { import_job_id: job });
      const untouched = await insert(owner.id, {});
      await finish(owner.id, job);
      // what undoImportAction sends
      const undone = await asUser(owner.id, (q) =>
        q(`update public.${table} set deleted_at = now() where organization_id = $1 and import_job_id = $2 and deleted_at is null`, [org, job]),
      );
      expect(undone.rowCount).toBe(2);
      await asAdmin(async (q) => {
        expect(await count(q, `select 1 from public.${table} where import_job_id = $1 and deleted_at is null`, [job])).toBe(0);
        expect(await count(q, `select 1 from public.${table} where id = $1 and deleted_at is null`, [untouched])).toBe(1);
      });

      const job2 = await newJob(owner.id, org, entity);
      await insert(owner.id, { import_job_id: job2 });
      const none = await asUser(member.id, (q) =>
        q(`update public.${table} set deleted_at = now() where organization_id = $1 and import_job_id = $2 and deleted_at is null`, [org, job2]),
      );
      expect(none.rowCount).toBe(0);
    }
  });

  it("deal_name_matches finds live deals by their whole name, under RLS, with quotes and commas", async () => {
    const odd = 'שיפוץ (חברה, בע"מ) \\ "גג"';
    const id = await deal(owner.id, { name: odd });
    const twin1 = await deal(owner.id, { name: "תאום" });
    const twin2 = await deal(owner.id, { name: "תאום" });
    const binned = await deal(owner.id, { name: "בסל" });
    await asUser(owner.id, (q) => q("update public.deals set deleted_at = now() where id = $1", [binned]));
    await deal(owner2.id, { name: odd, pipeline_id: (await defaultPipeline(other)).pipelineId, stage_id: (await defaultPipeline(other)).stages[0].id }, other);
    const matches = (userId: string, o: string, names: string[]) =>
      asUser(userId, async (q) => (await q<{ id: string }>("select id from public.deal_name_matches($1, $2) order by id", [o, names])).rows.map((r) => r.id));

    expect(await matches(owner.id, org, [odd, "תאום", "בסל", "אין כזו", " תאום"])).toEqual([id, twin1, twin2].sort());
    // another organization's id answers nothing (RLS), and its own deal is not in ours
    expect(await matches(owner2.id, org, [odd])).toEqual([]);
    expect((await matches(owner2.id, other, [odd])).includes(id)).toBe(false);
    // visibility 'own': a manager without a team does not find someone else's deal
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    const membersDeal = await deal(owner.id, { name: "של חבר צוות", owner_id: member.id });
    expect(await matches(manager.id, org, ["של חבר צוות"])).toEqual([]);
    expect(await matches(owner.id, org, ["של חבר צוות"])).toEqual([membersDeal]);
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    expect((await pgError(asAnon((q) => q("select * from public.deal_name_matches($1, $2)", [org, [odd]]))))).toMatchObject({ code: "42501" });
  });

  it("another organization sees none of the imports, deals or tasks, and cannot undo them", async () => {
    const job = await newJob(owner.id, org, "deal");
    const id = await deal(owner.id, { import_job_id: job });
    const taskJob = await newJob(owner.id, org, "task");
    const taskId = await task(owner.id, { import_job_id: taskJob });
    await asUser(owner2.id, async (q) => {
      expect(await count(q, "select 1 from public.import_jobs where id = any($1)", [[job, taskJob]])).toBe(0);
      expect(await count(q, "select 1 from public.deals where id = $1", [id])).toBe(0);
      expect(await count(q, "select 1 from public.tasks where id = $1", [taskId])).toBe(0);
      expect((await q("update public.deals set deleted_at = now() where import_job_id = $1", [job])).rowCount).toBe(0);
      expect((await q("update public.tasks set deleted_at = now() where import_job_id = $1", [taskJob])).rowCount).toBe(0);
      expect((await q("update public.import_jobs set status = 'undone' where id = $1", [job])).rowCount).toBe(0);
    });
  });
});
