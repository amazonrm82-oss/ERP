import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// REC-03 follow-up (owner, 14 October 2026): the record's owner is a built-in follower (told like a
// follower, without a row, never about their own action; a new owner moves it), and a change or an entry
// written by an import tells no follower.
describe("the owner follows their record; imports tell no follower (REC-03)", () => {
  let boss: U, rep: U, colleague: U, other: U, deputy: U;
  let org: string;
  let statuses: string[];

  const told = (u: U, entity?: string) =>
    asAdmin(async (q) =>
      (
        await q<{ body: string | null; entity_id: string }>(
          `select body, entity_id from public.notifications where user_id = $1 and type = 'follow' ${entity ? "and entity_id = $2" : ""} order by created_at, id`,
          entity ? [u.id, entity] : [u.id],
        )
      ).rows,
    );
  const since = async (u: U, fn: () => Promise<unknown>, entity?: string) => {
    const before = (await told(u, entity)).length;
    await fn();
    return (await told(u, entity)).slice(before);
  };
  // a lead owned by rep (created by the colleague, then handed over by the business owner)
  const repLead = async (name: string) => {
    const id = await insertLead(colleague.id, org, { full_name: name });
    await asUser(boss.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [id, rep.id]));
    return id;
  };
  const setStatus = (u: U, lead: string, i: number) => asUser(u.id, (q) => q("update public.leads set status_id = $2 where id = $1", [lead, statuses[i]]));

  beforeAll(async () => {
    boss = await createUser("fo-boss");
    org = await createOrg(boss.id);
    rep = await addMember(org, boss.id, "member", "fo-rep");
    colleague = await addMember(org, boss.id, "admin", "fo-colleague");
    other = await addMember(org, boss.id, "member", "fo-other");
    deputy = await addMember(org, boss.id, "member", "fo-deputy");
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org', timezone = 'Asia/Jerusalem' where id = $1", [org]));
    statuses = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.lead_statuses where organization_id = $1 and kind = 'open' order by position", [org])).rows.map((r) => r.id),
    );
    expect(statuses.length).toBeGreaterThanOrEqual(2);
  });

  it("the owner is told of a colleague's status change without a follower row, never of their own", async () => {
    const lead = await repLead("ליד של הנציג");
    expect(await since(rep, () => setStatus(colleague, lead, 1), lead)).toHaveLength(1);
    expect(await since(rep, () => setStatus(rep, lead, 0), lead)).toHaveLength(0);
    // a server change (no person) tells the owner too
    expect(await since(rep, () => asAdmin((q) => q("update public.leads set status_id = $2 where id = $1", [lead, statuses[1]])), lead)).toHaveLength(1);
  });

  it("an owner who also follows the record gets one notice", async () => {
    const lead = await repLead("ליד במעקב כפול");
    await asUser(rep.id, (q) => q("insert into public.record_followers (organization_id, lead_id) values ($1, $2)", [org, lead]));
    expect(await since(rep, () => setStatus(colleague, lead, 1), lead)).toHaveLength(1);
    expect(await since(rep, () => asUser(colleague.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'דיברנו', $2)", [org, lead])), lead)).toHaveLength(1);
  });

  it("a change of owner moves it: the new owner is not told of the owner change, the old owner no longer follows", async () => {
    const lead = await repLead("ליד שעובר");
    const toNew = await since(other, () => asUser(boss.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [lead, other.id])), lead);
    expect(toNew).toHaveLength(0);
    // the old owner had no row: nothing about the move, and nothing later
    expect(await since(rep, () => setStatus(colleague, lead, 1), lead)).toHaveLength(0);
    expect(await since(other, () => setStatus(colleague, lead, 0), lead)).toHaveLength(1);
    // an owner change together with a status change: the new owner hears only the status
    const both = await since(rep, () => asUser(boss.id, (q) => q("update public.leads set owner_id = $2, status_id = $3 where id = $1", [lead, rep.id, statuses[1]])), lead);
    expect(both).toHaveLength(1);
    expect(both[0].body).not.toContain("האחראי");
  });

  it("entries: the owner hears a colleague's logged entry, not their own, not a private note, not one that mentions them", async () => {
    const lead = await repLead("ליד עם תיעוד");
    const entry = (u: U, body: string, priv = false) =>
      asUser(u.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, 'note', $2, $3, $4)", [org, body, lead, priv]));
    expect(await since(rep, () => entry(colleague, "עדכון"), lead)).toHaveLength(1);
    expect(await since(rep, () => entry(rep, "שלי"), lead)).toHaveLength(0);
    expect(await since(rep, () => entry(colleague, "פרטי", true), lead)).toHaveLength(0);
    expect(await since(rep, () => entry(colleague, `@[נציג](user:${rep.id}) תראה`), lead)).toHaveLength(0);
    // one entry on a contact and a deal of the same owner: one notice
    const both = await asUser(colleague.id, async (q) => {
      const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'רות', $2) returning id", [org, rep.id])).rows[0].id;
      return contact;
    });
    expect(await since(rep, () => asUser(colleague.id, (q) => q("insert into public.activities (organization_id, type, body, contact_id, lead_id) values ($1, 'call', 'שיחה', $2, $3)", [org, both, lead])))).toHaveLength(1);
  });

  it("HEB-08: an absent owner is still told; their deputy is not a built-in follower", async () => {
    const lead = await repLead("ליד של נעדר");
    await asUser(boss.id, (q) =>
      q(
        `insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id)
         values ($1, $2, (now() at time zone 'Asia/Jerusalem')::date - 1, (now() at time zone 'Asia/Jerusalem')::date + 1, 'vacation', $3)`,
        [org, rep.id, deputy.id],
      ),
    );
    expect(await since(rep, () => setStatus(colleague, lead, 1), lead)).toHaveLength(1);
    expect(await since(deputy, () => setStatus(colleague, lead, 0), lead)).toHaveLength(0);
    await asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01', deputy_id = null where organization_id = $1", [org]));
  });

  it("an import's update tells no follower; the header counts only for a genuine import of the caller", async () => {
    const lead = await repLead("ליד בייבוא");
    await asUser(other.id, (q) => q("insert into public.record_followers (organization_id, lead_id) values ($1, $2)", [org, lead]));
    const newJob = (entity: string, mode: string) =>
      asUser(colleague.id, async (q) =>
        (
          await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, $2, 'file.csv', $3) returning id", [
            org,
            entity,
            mode,
          ])
        ).rows[0].id,
      );
    const withHeader = (u: U, header: string, sql: string, params: unknown[]) =>
      asUser(u.id, async (q) => {
        await q("select set_config('request.headers', $1, true)", [JSON.stringify({ "x-crm-import": header })]);
        await q(sql, params);
      });
    let i = 0;
    const statusChange = (u: U, header: string) => withHeader(u, header, "update public.leads set status_id = $2 where id = $1", [lead, statuses[i++ % 2]]);
    const job = await newJob("lead", "update");
    // the caller's own running update-mode lead import, made just now: nobody is told
    for (const u of [rep, other]) {
      expect(await since(u, () => statusChange(colleague, job), lead), u.email).toHaveLength(0);
    }
    // a note is never silenced, even with a genuine job's header
    expect(await since(rep, () => withHeader(colleague, job, "insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'הערה', $2)", [org, lead]), lead)).toHaveLength(1);
    // someone else's job, a made-up id: a normal change
    expect(await since(other, () => statusChange(boss, job), lead)).toHaveLength(1);
    expect(await since(other, () => statusChange(colleague, "00000000-0000-4000-8000-000000000000"), lead)).toHaveLength(1);
    // a job of another record type, or one that skips duplicates (it updates nothing): a normal change
    const contactJob = await newJob("contact", "update");
    const skipJob = await newJob("lead", "skip");
    expect(await since(other, () => statusChange(colleague, contactJob), lead)).toHaveLength(1);
    expect(await since(other, () => statusChange(colleague, skipJob), lead)).toHaveLength(1);
    // a job older than 2 hours: a normal change
    const old = await newJob("lead", "update");
    // created_at is kept by touch_row on every update; the test steps around the triggers to age the job
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.import_jobs set created_at = now() - interval '3 hours' where id = $1", [old]);
    });
    // and a client cannot write created_at at all (no column grant)
    const refused = await asUser(colleague.id, (q) => q("update public.import_jobs set created_at = now() where id = $1", [old])).then(
      () => null,
      (e: { code?: string }) => e.code,
    );
    expect(refused).toBe("42501");
    expect(await asAdmin(async (q) => (await q<{ old: boolean }>("select created_at < now() - interval '2 hours' as old from public.import_jobs where id = $1", [old])).rows[0].old)).toBe(true);
    expect(await since(other, () => statusChange(colleague, old), lead)).toHaveLength(1);
    // a finished job cannot be revived (any writer), so it never silences again
    await asUser(colleague.id, (q) => q("update public.import_jobs set status = 'failed' where id = $1", [job]));
    for (const reviver of [(f: (q: Parameters<Parameters<typeof asAdmin>[0]>[0]) => Promise<unknown>) => asUser(colleague.id, f), asAdmin]) {
      const err = await reviver((q) => q("update public.import_jobs set status = 'running' where id = $1", [job])).then(
        () => null,
        (e: { hint?: string }) => e,
      );
      expect(err?.hint).toBe("import:status");
    }
    expect(await since(other, () => statusChange(colleague, job), lead)).toHaveLength(1);
    // a running job may still be touched (running -> running), as every chunk does
    const live = await newJob("lead", "update");
    expect(await asUser(colleague.id, async (q) => (await q("update public.import_jobs set status = 'running' where id = $1 and status = 'running'", [live])).rowCount)).toBe(1);
  });
});
