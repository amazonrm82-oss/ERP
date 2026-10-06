import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const newJob = (userId: string, org: string, entity = "lead") =>
  asUser(userId, async (q) =>
    (
      await q<{ id: string }>(
        "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows) values ($1, $2, 'file.csv', 'skip', 3) returning id",
        [org, entity],
      )
    ).rows[0].id,
  );

describe("imports", () => {
  let owner: U, admin: U, manager: U, member: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    manager = await addMember(org, owner.id, "manager");
    member = await addMember(org, owner.id, "member");
  });

  it("owners, admins and team managers may start an import; members and viewers may not", async () => {
    for (const user of [owner, admin, manager]) {
      expect(await newJob(user.id, org)).toBeTruthy();
    }
    expect((await pgError(newJob(member.id, org))).code).toBe("42501");
    const viewer = await addMember(org, owner.id, "viewer");
    expect((await pgError(newJob(viewer.id, org))).code).toBe("42501");
  });

  it("a job belongs to whoever started it; admins see every job, others only their own", async () => {
    const job = await newJob(manager.id, org);
    expect(
      await asAdmin(async (q) => (await q<{ created_by: string }>("select created_by from public.import_jobs where id = $1", [job])).rows[0].created_by),
    ).toBe(manager.id);
    await asUser(member.id, async (q) => expect(await count(q, "select 1 from public.import_jobs where id = $1", [job])).toBe(0));
    await asUser(admin.id, async (q) => expect(await count(q, "select 1 from public.import_jobs where id = $1", [job])).toBe(1));
    // another importer cannot touch it
    await asUser(admin.id, async (q) => expect((await q("update public.import_jobs set status = 'failed' where id = $1", [job])).rowCount).toBe(0));
    await asUser(manager.id, async (q) => expect((await q("update public.import_jobs set status = 'done' where id = $1", [job])).rowCount).toBe(1));
    // counters and status only; the type and the file are fixed
    const err = await pgError(asUser(manager.id, (q) => q("update public.import_jobs set entity_type = 'company' where id = $1", [job])));
    expect(err.code).toBe("42501");
  });

  it("a record can carry only a running import of the same user and type, and never change it", async () => {
    const mine = await newJob(owner.id, org);
    const lead = await insertLead(owner.id, org, { import_job_id: mine });
    expect(lead).toBeTruthy();

    const someoneElses = await newJob(admin.id, org);
    expect((await pgError(insertLead(owner.id, org, { import_job_id: someoneElses }))).code).toBe("42501");

    const contactsJob = await newJob(owner.id, org, "contact");
    expect((await pgError(insertLead(owner.id, org, { import_job_id: contactsJob }))).code).toBe("42501");

    await asUser(owner.id, (q) => q("update public.import_jobs set status = 'done' where id = $1", [mine]));
    expect((await pgError(insertLead(owner.id, org, { import_job_id: mine }))).code).toBe("42501");

    const plain = await insertLead(owner.id, org);
    const running = await newJob(owner.id, org);
    const retag = await pgError(asUser(owner.id, (q) => q("update public.leads set import_job_id = $1 where id = $2", [running, plain])));
    expect(retag.code).toBe("42501");
  });

  it("imported records do not start automations or send assignment notifications", async () => {
    await asUser(owner.id, (q) =>
      q(
        "insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, 'ליד חדש', 'lead', 'created', $2)",
        [org, JSON.stringify([{ type: "notify", to: "owner", title: "ליד חדש: {{name}}" }])],
      ),
    );
    const job = await newJob(owner.id, org);
    const imported = await insertLead(owner.id, org, { import_job_id: job, owner_id: member.id, full_name: "מיובא" });
    const typed = await insertLead(owner.id, org, { owner_id: member.id, full_name: "הוקלד" });

    expect(
      await asAdmin(async (q) =>
        (await q<{ origin: string | null }>("select payload ->> 'origin' as origin from public.outbox_events where entity_id = $1", [imported])).rows[0].origin,
      ),
    ).toBe("import");

    await asAdmin((q) => q("select app.process_outbox(5000)"));
    await asAdmin(async (q) => {
      expect(await count(q, "select 1 from public.automation_runs where entity_id = $1", [imported])).toBe(0);
      expect(await count(q, "select 1 from public.automation_runs where entity_id = $1", [typed])).toBe(1);
      expect(await count(q, "select 1 from public.notifications where entity_id = $1 and type = 'assigned'", [imported])).toBe(0);
      expect(await count(q, "select 1 from public.notifications where entity_id = $1 and type = 'assigned'", [typed])).toBe(1);
    });
  });

  it("removing a job keeps its records and only clears the tag", async () => {
    const job = await newJob(owner.id, org);
    const lead = await insertLead(owner.id, org, { import_job_id: job });
    await asAdmin(async (q) => {
      await q("delete from public.import_jobs where id = $1", [job]);
      const row = (await q<{ import_job_id: string | null; organization_id: string }>("select import_job_id, organization_id from public.leads where id = $1", [lead])).rows[0];
      expect(row).toEqual({ import_job_id: null, organization_id: org });
    });
  });
});
