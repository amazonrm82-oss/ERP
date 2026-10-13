import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Row = Record<string, unknown>;
type Breakdown = { target_minutes: number; by_source: Row[]; by_hour: Row[] };

/**
 * SPD-06: the response time report adds the share answered within the target
 * (15 minutes until CAP-10), and a breakdown by lead source and by the hour of
 * the day the lead arrived, in the organization's time zone. Security invoker:
 * a member who may see only their own records gets numbers of their own leads.
 */
describe("response time report (SPD-06)", () => {
  let owner: U, member: U, outsider: U;
  let org: string;
  let s1: string, s2: string;
  // 15 January 2026: Israel is UTC+2
  const from = "2026-01-15T00:00:00Z";
  const to = "2026-01-16T00:00:00Z";

  const report = async <T = unknown>(userId: string, sql: string, params: unknown[]): Promise<T> =>
    asUser(userId, async (q) => (await q<{ r: T }>(`select ${sql} as r`, params)).rows[0].r);

  /** A lead created at `at` (UTC), first contacted by its owner `after` minutes later (or never). */
  const lead = async (user: U, source: string | null, at: string, after: number | null): Promise<string> => {
    const id = await insertLead(user.id, org, { owner_id: user.id, source_id: source });
    // touch_row keeps created_at as it was; skip triggers to date the lead
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.leads set created_at = $2 where id = $1", [id, at]);
      await q("set local session_replication_role = origin");
    });
    if (after !== null) {
      const occurred = new Date(Date.parse(at) + after * 60_000).toISOString();
      await asUser(user.id, (q) =>
        q("insert into public.activities (organization_id, type, body, lead_id, occurred_at) values ($1, 'call', 'שיחה', $2, $3)", [
          org,
          id,
          occurred,
        ]),
      );
    }
    return id;
  };

  beforeAll(async () => {
    owner = await createUser("owner");
    outsider = await createUser("outsider");
    org = await createOrg(owner.id);
    await createOrg(outsider.id, "עסק אחר");
    member = await addMember(org, owner.id, "member", "rep");

    [s1, s2] = await asAdmin(async (q) =>
      (
        await q<{ id: string }>(`select id from public.lead_sources where organization_id = $1 order by name collate "C" limit 2`, [org])
      ).rows.map((r) => r.id),
    );

    const first = await lead(owner, s1, "2026-01-15T08:10:00Z", 10); // 10:10 local, within the target
    // a private note 2 minutes in is not contact with the customer (LEAD-02); the owner reads it, so only the rule hides it
    await asUser(owner.id, (q) =>
      q("insert into public.activities (organization_id, type, body, lead_id, occurred_at, is_private) values ($1, 'note', 'פרטי', $2, $3, true)", [
        org,
        first,
        "2026-01-15T08:12:00Z",
      ]),
    );
    await lead(owner, s1, "2026-01-15T08:30:00Z", 40); // 10:30 local, within an hour only
    await lead(member, s2, "2026-01-15T18:05:00Z", 5); // 20:05 local, within the target
    await lead(member, null, "2026-01-15T18:20:00Z", null); // 20:20 local, no contact
    await lead(owner, s1, "2026-01-16T08:10:00Z", 1); // outside the period
  });

  it("per owner: the share within the target next to the share within an hour", async () => {
    const rows = await report<Row[]>(owner.id, "public.report_response_time($1, $2, $3)", [org, from, to]);
    expect(rows.find((r) => r.owner_id === owner.id)).toMatchObject({
      leads: 2,
      contacted: 2,
      within_target: 1,
      within_hour: 2,
      avg_minutes: 25,
      median_minutes: 25,
    });
    expect(rows.find((r) => r.owner_id === member.id)).toMatchObject({ leads: 2, contacted: 1, within_target: 1, within_hour: 1 });
  });

  it("a private note before the first call does not count as the first contact", async () => {
    const data = await report<Breakdown>(owner.id, "public.report_response_breakdown($1, $2, $3)", [org, from, to]);
    // 10 and 40 minutes (the calls), not 2 and 40 (the private note)
    expect(data.by_hour.find((r) => r.hour === 10)).toMatchObject({ avg_minutes: 25, median_minutes: 25 });
    const rows = await report<Row[]>(owner.id, "public.report_response_time($1, $2, $3)", [org, from, to]);
    expect(rows.find((r) => r.owner_id === owner.id)).toMatchObject({ avg_minutes: 25 });
  });

  it("by source and by hour of arrival, in the organization's time zone", async () => {
    const data = await report<Breakdown>(owner.id, "public.report_response_breakdown($1, $2, $3)", [org, from, to]);
    expect(data.target_minutes).toBe(15);
    expect(data.by_source.find((r) => r.source_id === s1)).toMatchObject({
      leads: 2,
      contacted: 2,
      within_target: 1,
      avg_minutes: 25,
      median_minutes: 25,
    });
    expect(data.by_source.find((r) => r.source_id === s2)).toMatchObject({ leads: 1, contacted: 1, within_target: 1, avg_minutes: 5 });
    expect(data.by_source.find((r) => r.source_id === null)).toMatchObject({ leads: 1, contacted: 0, within_target: 0, avg_minutes: null });
    expect(data.by_source.find((r) => r.source_id === s1)?.source_name).toBeTruthy();
    expect(data.by_hour).toEqual([
      { hour: 10, leads: 2, contacted: 2, within_target: 1, avg_minutes: 25, median_minutes: 25 },
      { hour: 20, leads: 2, contacted: 1, within_target: 1, avg_minutes: 5, median_minutes: 5 },
    ]);

    // the owner filter applies to the breakdown too
    const mine = await report<Breakdown>(owner.id, "public.report_response_breakdown($1, $2, $3, $4)", [org, from, to, member.id]);
    expect(mine.by_hour.map((r) => r.hour)).toEqual([20]);

    await asAdmin((q) => q("update public.organizations set timezone = 'America/New_York' where id = $1", [org]));
    try {
      const ny = await report<Breakdown>(owner.id, "public.report_response_breakdown($1, $2, $3)", [org, from, to]);
      expect(ny.by_hour.map((r) => [r.hour, r.leads])).toEqual([
        [3, 2],
        [13, 2],
      ]);
    } finally {
      await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    }
  });

  it("a member limited to their own records gets numbers of their own leads only", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const rows = await report<Row[]>(member.id, "public.report_response_time($1, $2, $3)", [org, from, to]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ owner_id: member.id, leads: 2, within_target: 1 });
      const data = await report<Breakdown>(member.id, "public.report_response_breakdown($1, $2, $3)", [org, from, to]);
      expect(data.by_source.reduce((sum, r) => sum + Number(r.leads), 0)).toBe(2);
      expect(data.by_source.find((r) => r.source_id === s1)).toBeUndefined();
      expect(data.by_hour.map((r) => r.hour)).toEqual([20]);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("another organization sees nothing, and anonymous callers are refused", async () => {
    const data = await report<Breakdown>(outsider.id, "public.report_response_breakdown($1, $2, $3)", [org, from, to]);
    expect(data.by_source).toEqual([]);
    expect(data.by_hour).toEqual([]);
    const err = await pgError(asAnon((q) => q("select public.report_response_breakdown($1, now(), now())", [org])));
    expect(err.code).toBe("42501");
  });
});
