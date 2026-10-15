import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { REPORTS } from "../../src/features/reports/definitions";
import { parseReportData } from "../../src/features/reports/schemas";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Report = ReturnType<typeof parseReportData<"report_meetings">>;

// CAL-11: public.report_meetings counts the meetings that START in [from, to), per organizer.
// held / no_show / cancelled by status; not_updated = planned and already ended; upcoming = planned
// and not ended; no_show_rate = no_show / (held + no_show), null below 5. "Led to a deal" = a held
// meeting with one deal picked (its own deal, else its lead's conversion deal, else its contact's deal
// created after it and closed first) that is won, not in the bin, and closed within 90 days of the
// meeting's start; each deal once. Owner's answers of 15 October 2026.
describe("meeting reports (CAL-11)", () => {
  let owner: U;
  let rep: U;
  let other: U;
  let org: string;
  let pipelineId: string;
  let openStage: string;
  let wonStage: string;
  const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
  const from = hours(-24 * 7);
  const to = hours(24 * 7);

  const meeting = (userId: string, startHours: number, status: string, dealId: string | null = null) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.meetings (organization_id, title, starts_at, ends_at, status, deal_id)
           values ($1, 'פגישה', $2, $3, $4, $5) returning id`,
          [org, hours(startHours), hours(startHours + 1), status, dealId],
        )
      ).rows[0].id,
    );
  const deal = (userId: string, name: string, amount: number, stage: string, closedAt: string | null = null) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id, closed_at)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [org, name, amount, pipelineId, stage, userId, closedAt],
        )
      ).rows[0].id,
    );
  const report = (userId: string, ownerId: string | null = null, orgId = org): Promise<Report> =>
    asUser(userId, async (q) =>
      parseReportData(
        "report_meetings",
        (await q<{ r: unknown }>("select public.report_meetings($1, $2, $3, $4) as r", [orgId, from, to, ownerId])).rows[0].r,
      ),
    );

  beforeAll(async () => {
    owner = await createUser("mtr-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "mtr-rep");
    other = await createUser("mtr-other");
    await createOrg(other.id, "עסק אחר");
    const p = await defaultPipeline(org);
    pipelineId = p.pipelineId;
    openStage = p.stages.find((s) => s.kind === "open")!.id;
    wonStage = p.stages.find((s) => s.kind === "won")!.id;

    // won now, two held meetings before it: two meetings led to one deal
    const wonNow = await deal(owner.id, "נסגרה עכשיו", 100000, wonStage);
    await meeting(owner.id, -48, "held", wonNow);
    await meeting(owner.id, -30, "held", wonNow);
    // won ten days ago: a held meeting after the close did not lead to it
    const wonBefore = await deal(owner.id, "נסגרה קודם", 70000, wonStage, hours(-24 * 10));
    await meeting(owner.id, -20, "held", wonBefore);
    // an open deal: held, not led
    const open = await deal(owner.id, "פתוחה", 40000, openStage);
    await meeting(owner.id, -10, "held", open);
    // a won deal whose meeting was a no-show: not led
    const wonNoShow = await deal(owner.id, "לא הגיע", 30000, wonStage);
    await meeting(owner.id, -6, "no_show", wonNoShow);
    // a won deal in the recycle bin: not led
    const binned = await deal(owner.id, "בסל", 20000, wonStage);
    await meeting(owner.id, -5, "held", binned);
    await asUser(owner.id, (q) => q("update public.deals set deleted_at = now() where id = $1", [binned]));
    // planned: one already ended (not updated), one ahead (upcoming), one cancelled
    await meeting(owner.id, -3, "planned");
    await meeting(owner.id, 3, "planned");
    await meeting(owner.id, 4, "cancelled");
    // outside the period: not counted
    await meeting(owner.id, -24 * 8, "held", wonNow);
    await meeting(owner.id, 24 * 8, "planned");
    // the rep's own: one held on the rep's won deal, one no-show
    const repWon = await deal(rep.id, "של הנציג", 50000, wonStage);
    await meeting(rep.id, -12, "held", repWon);
    await meeting(rep.id, -2, "no_show");
  });

  it("counts by status, per organizer, and each won deal once", async () => {
    const r = await report(owner.id);
    expect(r.totals).toEqual({
      meetings: 11,
      held: 6,
      no_show: 2,
      no_show_rate: 25,
      cancelled: 1,
      not_updated: 1,
      upcoming: 1,
      led_meetings: 3,
      won_deals: 2,
      won_amount: 150000,
    });
    const byOwner = new Map(r.by_owner.map((row) => [row.owner_id, row]));
    expect(byOwner.get(owner.id)).toEqual({
      owner_id: owner.id,
      meetings: 9,
      held: 5,
      no_show: 1,
      no_show_rate: 16.7,
      cancelled: 1,
      not_updated: 1,
      upcoming: 1,
      led_meetings: 2,
      won_deals: 1,
      won_amount: 100000,
    });
    // two meetings held or missed: below five, no rate
    expect(byOwner.get(rep.id)).toMatchObject({ meetings: 2, held: 1, no_show: 1, no_show_rate: null, led_meetings: 1, won_deals: 1, won_amount: 50000 });
    expect(r.led_window_days).toBe(90);
    expect(r.no_show_min).toBe(5);
    expect(r.deals.map((d) => [d.name, d.meetings, d.amount])).toEqual(
      expect.arrayContaining([
        ["נסגרה עכשיו", 2, 100000],
        ["של הנציג", 1, 50000],
      ]),
    );
    expect(r.deals).toHaveLength(2);
  });

  it("narrows to one organizer", async () => {
    const r = await report(owner.id, rep.id);
    expect(r.totals).toMatchObject({ meetings: 2, held: 1, no_show: 1, no_show_rate: null, led_meetings: 1, won_deals: 1, won_amount: 50000 });
    expect(r.by_owner.map((row) => row.owner_id)).toEqual([rep.id]);
  });

  it("counts only what the caller may read (RLS), and nothing of another organization", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const r = await report(rep.id);
      expect(r.totals).toMatchObject({ meetings: 2, held: 1, no_show: 1, led_meetings: 1, won_deals: 1 });
      expect(r.by_owner.map((row) => row.owner_id)).toEqual([rep.id]);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    const outsider = await report(other.id);
    expect(outsider.totals.meetings).toBe(0);
    expect(outsider.by_owner).toEqual([]);
    expect(outsider.deals).toEqual([]);
  });

  it("is security invoker and closed to anon", async () => {
    const fn = await asAdmin(
      async (q) =>
        (
          await q<{ definer: boolean; anon: boolean; authed: boolean }>(
            `select p.prosecdef as definer,
                    has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('authenticated', p.oid, 'execute') as authed
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'report_meetings'`,
          )
        ).rows,
    );
    expect(fn).toEqual([{ definer: false, anon: false, authed: true }]);
  });

  it("every report on the reports page may be exported (log_export keeps the same keys)", async () => {
    for (const { key } of REPORTS) {
      await asUser(owner.id, (q) => q("select public.log_export($1, 'report', $2, 1, 'csv')", [org, key]));
    }
    const logged = await asAdmin(
      async (q) =>
        (await q<{ report: string }>("select changes->>'report' as report from public.audit_log where organization_id = $1 and action = 'export'", [org])).rows,
    );
    expect(logged.map((row) => row.report).sort()).toEqual(REPORTS.map((r) => r.key).sort());
  });
});

// CAL-11: the three ways a held meeting finds its deal, the 90-day window, and RLS on each path.
describe("meeting reports: which deal a meeting led to (CAL-11)", () => {
  let owner: U;
  let rep: U;
  let org: string;
  let pipelineId: string;
  let openStage: string;
  let wonStage: string;
  const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

  const meeting = (userId: string, startHours: number, links: { deal?: string; lead?: string; contact?: string } = {}) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.meetings (organization_id, title, starts_at, ends_at, status, deal_id, lead_id, contact_id)
           values ($1, 'פגישה', $2, $3, 'held', $4, $5, $6) returning id`,
          [org, at(startHours), at(startHours + 1), links.deal ?? null, links.lead ?? null, links.contact ?? null],
        )
      ).rows[0].id,
    );
  const deal = (userId: string, name: string, amount: number, stage: string, extra: { contact?: string; closedAt?: string } = {}) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id, contact_id, closed_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [org, name, amount, pipelineId, stage, userId, extra.contact ?? null, extra.closedAt ?? null],
        )
      ).rows[0].id,
    );
  const contact = (userId: string, name: string) =>
    asUser(userId, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, userId])).rows[0].id,
    );
  const win = (userId: string, dealId: string) =>
    asUser(userId, (q) => q("update public.deals set stage_id = $2 where id = $1", [dealId, wonStage]));
  // converts a lead with a deal; the meeting is added on the lead afterwards, so only the lead links it
  const convertedLead = async (userId: string) => {
    const lead = await insertLead(userId, org, { owner_id: userId });
    const dealId = await asUser(userId, async (q) =>
      (await q<{ r: { deal_id: string } }>("select public.convert_lead($1, true, null, 30000) as r", [lead])).rows[0].r.deal_id,
    );
    return { lead, dealId };
  };
  const report = (userId: string, fromHours: number, toHours = 24): Promise<Report> =>
    asUser(userId, async (q) =>
      parseReportData(
        "report_meetings",
        (await q<{ r: unknown }>("select public.report_meetings($1, $2, $3) as r", [org, at(fromHours), at(toHours)])).rows[0].r,
      ),
    );
  const ledNames = (r: Report) => r.deals.map((d) => d.name).sort();

  beforeEach(async () => {
    owner = await createUser("mtd-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "mtd-rep");
    const p = await defaultPipeline(org);
    pipelineId = p.pipelineId;
    openStage = p.stages.find((s) => s.kind === "open")!.id;
    wonStage = p.stages.find((s) => s.kind === "won")!.id;
  });

  it("step 2: a meeting on a converted lead counts with the lead's conversion deal", async () => {
    const { lead, dealId } = await convertedLead(owner.id);
    await meeting(owner.id, -5, { lead });
    expect((await report(owner.id, -24)).totals.led_meetings).toBe(0);
    await win(owner.id, dealId);
    const r = await report(owner.id, -24);
    expect(r.totals).toMatchObject({ led_meetings: 1, won_deals: 1, won_amount: 30000 });
    expect(r.deals.map((d) => d.deal_id)).toEqual([dealId]);
  });

  it("step 3: the contact's won deal created after the meeting and closed first; one deal per meeting", async () => {
    const c = await contact(owner.id, "דנה");
    // closed first of all, inside the window: it loses only because it was created before the meeting
    // (inserted as the server: created_at is set on insert and kept by touch_row afterwards)
    await asAdmin((q) =>
      q(
        `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id, contact_id, closed_at, created_at)
         values ($1, 'לפני הפגישה', 11000, $2, $3, $4, $5, $6, $7)`,
        [org, pipelineId, wonStage, owner.id, c, at(-3), at(-6)],
      ),
    );
    await meeting(owner.id, -5, { contact: c });
    await deal(owner.id, "ראשונה", 22000, wonStage, { contact: c, closedAt: at(-2) });
    await deal(owner.id, "שנייה", 33000, wonStage, { contact: c });
    await deal(owner.id, "פתוחה", 44000, openStage, { contact: c });
    const r = await report(owner.id, -24);
    expect(r.totals).toMatchObject({ led_meetings: 1, won_deals: 1, won_amount: 22000 });
    expect(ledNames(r)).toEqual(["ראשונה"]);
  });

  it("the step is decided by the link: a picked deal that is not won is not replaced by the next step", async () => {
    const c = await contact(owner.id, "רון");
    // step 1: an open deal of its own, though the contact has a won deal after the meeting
    const open = await deal(owner.id, "פתוחה", 10000, openStage);
    await meeting(owner.id, -5, { deal: open, contact: c });
    // step 2: a conversion deal still open
    const { lead } = await convertedLead(owner.id);
    await meeting(owner.id, -4, { lead, contact: c });
    await deal(owner.id, "של איש הקשר", 20000, wonStage, { contact: c });
    const r = await report(owner.id, -24);
    expect(r.totals).toMatchObject({ held: 2, led_meetings: 0, won_deals: 0 });
  });

  it("only a deal won within 90 days of the meeting's start", async () => {
    const inside = await deal(owner.id, "בתוך 90", 10000, openStage);
    const outside = await deal(owner.id, "אחרי 90", 20000, openStage);
    await meeting(owner.id, -24 * 89, { deal: inside });
    await meeting(owner.id, -24 * 91, { deal: outside });
    await win(owner.id, inside);
    await win(owner.id, outside);
    const r = await report(owner.id, -24 * 120);
    expect(r.totals).toMatchObject({ held: 2, led_meetings: 1, won_deals: 1, won_amount: 10000 });
    expect(ledNames(r)).toEqual(["בתוך 90"]);
  });

  it("the window includes its last instant: closed exactly 90 days after the start counts, a second later does not", async () => {
    // closed_at is computed in SQL with the function's own expression (starts_at + make_interval(days => 90)),
    // so the test holds in any session time zone, across a clock change too
    const edge = (name: string, startMs: number, extraSeconds: number) =>
      asUser(owner.id, async (q) => {
        const start = new Date(startMs).toISOString();
        const id = (
          await q<{ id: string }>(
            `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id, closed_at)
             values ($1, $2, 10000, $3, $4, $5, $6::timestamptz + make_interval(days => 90, secs => $7)) returning id`,
            [org, name, pipelineId, wonStage, owner.id, start, extraSeconds],
          )
        ).rows[0].id;
        await q(
          `insert into public.meetings (organization_id, title, starts_at, ends_at, status, deal_id)
           values ($1, 'פגישה', $2, $2::timestamptz + interval '1 hour', 'held', $3)`,
          [org, start, id],
        );
      });
    // a fixed start whose 90 days cross Israel's spring clock change (27 March 2026)
    const start = Date.parse("2026-01-05T10:00:00Z");
    await edge("בדיוק 90", start, 0);
    await edge("שנייה אחרי", start - 3_600_000, 1);
    const r = await report(owner.id, -(Date.now() - start) / 3_600_000 - 48);
    expect(r.led_window_days).toBe(90);
    expect(ledNames(r)).toEqual(["בדיוק 90"]);
  });

  it("a deal or lead the caller cannot read never counts, on each of the three paths", async () => {
    // all three deals (and the lead and contact) belong to the owner; the meetings are the rep's
    const direct = await deal(owner.id, "ישירה", 10000, wonStage);
    const { lead, dealId: converted } = await convertedLead(owner.id);
    await win(owner.id, converted);
    const c = await contact(owner.id, "נועה");
    await meeting(rep.id, -6, { deal: direct });
    await meeting(rep.id, -5, { lead });
    await meeting(rep.id, -4, { contact: c });
    await deal(owner.id, "של איש הקשר", 20000, wonStage, { contact: c });

    // the owner reads everything: all three meetings led to a deal
    const all = await report(owner.id, -24);
    expect(all.totals).toMatchObject({ held: 3, led_meetings: 3, won_deals: 3, won_amount: 60000 });

    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    const mine = await report(rep.id, -24);
    expect(mine.totals).toMatchObject({ held: 3, led_meetings: 0, won_deals: 0, won_amount: 0 });
    expect(mine.deals).toEqual([]);
    expect(mine.by_owner).toEqual([expect.objectContaining({ owner_id: rep.id, held: 3, led_meetings: 0, won_deals: 0 })]);
  });

  it("a readable meeting linked to an unreadable won deal: held 1, nothing won, the deal not listed", async () => {
    const hidden = await deal(owner.id, "נסתרת", 50000, wonStage);
    await meeting(rep.id, -3, { deal: hidden });
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    const r = await report(rep.id, -24);
    expect(r.totals).toMatchObject({ meetings: 1, held: 1, led_meetings: 0, won_deals: 0, won_amount: 0 });
    expect(r.deals).toEqual([]);
    // the owner, who reads the deal, sees it led
    expect((await report(owner.id, -24)).totals).toMatchObject({ held: 1, led_meetings: 1, won_amount: 50000 });
  });

  it("no-show rate shows from five meetings held or missed", async () => {
    const add = (status: string) =>
      asUser(owner.id, (q) =>
        q("insert into public.meetings (organization_id, title, starts_at, ends_at, status) values ($1, 'x', $2, $3, $4)", [org, at(-3), at(-2), status]),
      );
    for (const status of ["held", "held", "held", "no_show", "cancelled", "planned"]) await add(status);
    let r = await report(owner.id, -24);
    expect(r.totals.no_show_rate).toBeNull();
    expect(r.by_owner[0].no_show_rate).toBeNull();
    await add("no_show");
    r = await report(owner.id, -24);
    expect(r.totals.no_show_rate).toBe(40);
    expect(r.by_owner[0].no_show_rate).toBe(40);
  });
});
