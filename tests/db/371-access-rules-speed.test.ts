import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultLeadStatus } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * OPS-09 (migration 021280): a list of a large business stays well under the hosted statement timeout. Before, every
 * row paid app.can_read_record() and the SQL definers it calls, each planned again per call: on 300,000 leads an owner's
 * count took about 20 s and a page sorted by owner timed out (scripts/perf/access-load-RESULTS.md). The read rule is now a
 * set judged once per statement. 40,000 leads and 20,000 tasks in 'team' visibility, analyzed first (unanalyzed
 * estimates hide plans that real statistics pick, 021144); the bounds are generous on purpose (about 100x the
 * local time for the rule, about 7x for the owner sort).
 */
describe("access rules on a large business (OPS-09)", () => {
  let owner: U, manager: U, member: U, viewer: U;
  let org: string;
  const LEADS = 40000;
  const BOUND_MS = 3000;
  // sorting by owner reads one name per row (about 30 µs locally): bounded by the hosted statement timeout
  const SORT_BOUND_MS = 8000;

  beforeAll(async () => {
    owner = await createUser("o9s-owner");
    org = await createOrg(owner.id, "עסק גדול");
    manager = await addMember(org, owner.id, "manager", "o9s-manager");
    member = await addMember(org, owner.id, "member", "o9s-member");
    viewer = await addMember(org, owner.id, "viewer", "o9s-viewer");
    const others: U[] = [];
    for (let i = 0; i < 8; i += 1) others.push(await addMember(org, owner.id, "member", `o9s-m${i}`));
    await asAdmin(async (q) => {
      await q("update public.organizations set record_visibility = 'team' where id = $1", [org]);
      const team = async (name: string, parent: string | null) =>
        (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, $2, $3) returning id", [org, name, parent])).rows[0].id;
      const parent = await team("ראשי", null);
      const teams = [await team("א", parent), await team("ב", parent), await team("ג", null)];
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [org, parent, manager.id]);
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3), ($1, $2, $4)", [org, teams[0], member.id, viewer.id]);
      const owners = [member, ...others];
      for (let i = 0; i < others.length; i += 1) {
        await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, teams[i % 3], others[i].id]);
      }
      const status = await defaultLeadStatus(org);
      await q("set local session_replication_role = replica");
      await q(
        `insert into public.leads (organization_id, status_id, full_name, email, owner_id, team_id, created_at)
         select $1, $2, 'ליד ' || g, 'l' || g || '@example.test', ($3::uuid[])[1 + g % $5], ($4::uuid[])[1 + g % 3], now() - g * interval '1 minute'
           from generate_series(1, $6) g`,
        [org, status, owners.map((o) => o.id), teams, owners.length, LEADS],
      );
      await q(
        `insert into public.tasks (organization_id, title, owner_id, team_id, status, created_by, created_at)
         select $1, 'משימה ' || g, ($3::uuid[])[1 + g % $5], ($4::uuid[])[1 + g % 3], 'open', $2, now() - g * interval '1 minute'
           from generate_series(1, 20000) g`,
        [org, owner.id, owners.map((o) => o.id), teams, owners.length],
      );
    });
    await asAdmin((q) => q("analyze public.leads, public.tasks, public.team_members, public.teams, public.memberships, public.profiles"));
  });

  const timed = async (who: U, sql: string) => {
    const started = Date.now();
    const rows = await asUser(who.id, async (q) => (await q<{ n: string }>(sql, [org])).rows, { aal: "aal1" });
    return { took: Date.now() - started, rows };
  };

  it.each([
    ["owner", () => owner, LEADS],
    ["manager of the parent team", () => manager, Math.round((LEADS * 2) / 3)],
    ["member", () => member, Math.round(LEADS / 3)],
    ["viewer", () => viewer, Math.round(LEADS / 3)],
  ])("%s: count, first page, search and owner sort of 40,000 leads within the bound", async (name, who, expected) => {
    const count = await timed(who(), "select count(*) as n from public.leads where organization_id = $1 and deleted_at is null");
    const page = await timed(who(), "select id as n from public.leads where organization_id = $1 and deleted_at is null order by created_at desc, id desc limit 51");
    const search = await timed(who(), "select id as n from public.leads x where organization_id = $1 and deleted_at is null and public.search_text(x) like '%77%' order by created_at desc, id desc limit 51");
    const sorted = await timed(who(), "select id as n from public.leads x where organization_id = $1 and deleted_at is null order by public.sort_owner(x) nulls last, id limit 51");
    const tasks = await timed(who(), "select count(*) as n from public.tasks where organization_id = $1 and deleted_at is null");
    console.info(`OPS-09 ${name}: count ${count.took} ms, page ${page.took} ms, search ${search.took} ms, sort_owner ${sorted.took} ms, tasks ${tasks.took} ms`);
    expect(Math.abs(Number(count.rows[0].n) - expected)).toBeLessThanOrEqual(1);
    expect(page.rows).toHaveLength(51);
    expect(sorted.rows).toHaveLength(51);
    for (const t of [count, page, search, tasks]) expect(t.took).toBeLessThan(BOUND_MS);
    expect(sorted.took).toBeLessThan(SORT_BOUND_MS);
  });
});
