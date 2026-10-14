import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const token = (user: U, name = "שם") => `@[${name}](user:${user.id})`;

// HEB-08 (owner, 14 October 2026): an absence ("במילואים" / "בחופשה") with dates and a
// deputy. New leads meant for the absent person go to the deputy; the absent person's open
// tasks stay theirs but the deputy sees, works and is reminded of them; the deputy reads the
// records those tasks link and the absent person's unanswered open leads, only while the
// absence lasts; no chain.
describe("absence with a deputy (HEB-08)", () => {
  let owner: U, admin: U, away: U, deputy: U, rep3: U, viewer: U, outsider: U;
  let org: string, otherOrg: string, team: string;
  let formToken: string, rotationToken: string;

  const clearLeaves = () => asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01', deputy_id = null where organization_id = $1", [org]));
  // an absence covering today, written as the owner (RLS and the deputy check apply)
  const absent = (user: U, deputyUser: U | null, kind: string | null = "vacation", from = -1, to = 2) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id)
           values ($1, $2, (now() at time zone 'Asia/Jerusalem')::date + $3::int, (now() at time zone 'Asia/Jerusalem')::date + $4::int, $5, $6) returning id`,
          [org, user.id, from, to, kind, deputyUser?.id ?? null],
        )
      ).rows[0].id,
    );
  const submit = (tok: string, phone: string) =>
    asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [tok, JSON.stringify({ full_name: "פונה", phone })])).rows[0].r.lead_id);
  const ownerOf = (lead: string) => asAdmin(async (q) => (await q<{ o: string | null }>("select owner_id as o from public.leads where id = $1", [lead])).rows[0].o);
  const pointer = (user: U) =>
    asAdmin(async (q) => (await q<{ t: Date | null }>("select last_lead_assigned_at as t from public.memberships where organization_id = $1 and user_id = $2", [org, user.id])).rows[0].t?.getTime() ?? null);
  const order = (users: U[]) =>
    asAdmin(async (q) => {
      for (const [i, user] of users.entries()) {
        await q("update public.memberships set last_lead_assigned_at = now() - make_interval(hours => $3) where organization_id = $1 and user_id = $2", [org, user.id, 10 - i]);
      }
    });
  const sees = (user: U, table: string, id: string) =>
    asUser(user.id, async (q) => (await q(`select 1 from public.${table} where id = $1`, [id])).rowCount === 1);
  const task = (owner_id: string, links: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    asUser(owner.id, async (q) => {
      const row: Record<string, unknown> = { organization_id: org, title: "לחזור ללקוח", owner_id, ...links, ...extra };
      const cols = Object.keys(row);
      return (
        await q<{ id: string }>(
          `insert into public.tasks (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          Object.values(row),
        )
      ).rows[0].id;
    });
  const contact = (name: string, ownerId: string) =>
    asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, ownerId])).rows[0].id,
    );

  beforeAll(async () => {
    owner = await createUser("dp-owner");
    org = await createOrg(owner.id, "עסק ממלא המקום");
    admin = await addMember(org, owner.id, "admin", "dp-admin");
    away = await addMember(org, owner.id, "member", "dp-away");
    deputy = await addMember(org, owner.id, "member", "dp-deputy");
    rep3 = await addMember(org, owner.id, "member", "dp-rep3");
    viewer = await addMember(org, owner.id, "viewer", "dp-viewer");
    outsider = await createUser("dp-outsider");
    otherOrg = await createOrg(outsider.id, "עסק זר");
    await asAdmin(async (q) => {
      await q("update public.organizations set record_visibility = 'own', timezone = 'Asia/Jerusalem' where id = $1", [org]);
      await q("update public.profiles set full_name = 'דנה הנעדרת' where id = $1", [away.id]);
    });
    await asUser(owner.id, async (q) => {
      team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'סבב') returning id", [org])).rows[0].id;
      for (const user of [away, rep3]) {
        await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, user.id]);
      }
      formToken = (await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id, assign_mode) values ($1, 'webhook', 'טופס קבוע', $2, 'owner') returning token", [org, away.id])).rows[0].token;
      rotationToken = (await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id, assign_mode, team_id) values ($1, 'webhook', 'טופס סבב', $2, 'round_robin', $3) returning token", [org, owner.id, team])).rows[0].token;
    });
  });

  it("the deputy is an active member, not the person, not away on those days; the kind is closed", async () => {
    await clearLeaves();
    const hint = async (deputyUser: U | { id: string }, user: U = away) =>
      (await pgError(asUser(owner.id, (q) =>
        q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id) values ($1, $2, current_date, current_date + 1, 'reserve', $3)", [org, user.id, deputyUser.id]),
      ))).hint;
    expect(await hint(away)).toBe("member_leaves:deputy_self");
    expect(await hint(viewer)).toBe("member_leaves:deputy_inactive");
    expect(await hint(outsider)).toBe("member_leaves:deputy_inactive");
    // the deputy has a leave of their own that overlaps
    await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, current_date + 1, current_date + 3)", [org, deputy.id]));
    expect(await hint(deputy)).toBe("member_leaves:deputy_absent");
    await clearLeaves();
    // a suspended member is not a deputy
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, rep3.id]));
    expect(await hint(rep3)).toBe("member_leaves:deputy_inactive");
    await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, rep3.id]));
    expect((await pgError(asUser(owner.id, (q) =>
      q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind) values ($1, $2, current_date, current_date, 'sick')", [org, away.id]),
    ))).code).toBe("23514");
    // the person sets their own, and changes the deputy later; moving the dates onto the deputy's leave is refused
    const id = await asUser(away.id, async (q) =>
      (await q<{ id: string }>("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id) values ($1, $2, current_date + 10, current_date + 12, 'vacation', $3) returning id", [org, away.id, deputy.id])).rows[0].id,
    );
    await asUser(away.id, (q) => q("update public.member_leaves set deputy_id = $2 where id = $1", [id, rep3.id]));
    // an admin sets a member's absence with a deputy too (the CAP-09 writers)
    await asUser(admin.id, (q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id) values ($1, $2, current_date + 30, current_date + 31, 'reserve', $3)", [org, away.id, deputy.id]));
    await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, current_date + 20, current_date + 20)", [org, rep3.id]));
    expect((await pgError(asUser(away.id, (q) => q("update public.member_leaves set ends_on = current_date + 20 where id = $1", [id])))).hint).toBe("member_leaves:deputy_absent");
    // a colleague may not write someone else's leave, and an outsider learns nothing (plain RLS refusal, no hint)
    const denied = await pgError(asUser(rep3.id, (q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, deputy_id) values ($1, $2, current_date, current_date, $2)", [org, away.id])));
    expect(denied.code).toBe("42501");
    expect(denied.hint).toBeUndefined();
    const foreign = await pgError(asUser(outsider.id, (q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, deputy_id) values ($1, $2, current_date, current_date, $3)", [org, away.id, viewer.id])));
    expect(foreign.code).toBe("42501");
    expect(foreign.hint).toBeUndefined();
    await clearLeaves();
  });

  it("a form's fixed owner: away -> the deputy; no deputy, or a deputy away too -> no owner (SPD-01), no chain", async () => {
    await clearLeaves();
    expect(await ownerOf(await submit(formToken, "050-8100001"))).toBe(away.id);
    const leave = await absent(away, deputy);
    const lead = await submit(formToken, "050-8100002");
    expect(await ownerOf(lead)).toBe(deputy.id);
    // the deputy is told as the owner of a new lead
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and entity_id = $2 and type = 'lead_new'", [deputy.id, lead]))).toBe(1);
    // the deputy is away too (their own deputy is rep3): nobody owns it, the would-be takers are told
    await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, deputy_id) values ($1, $2, current_date - 1, current_date + 1, $3)", [org, deputy.id, rep3.id]));
    const orphan = await submit(formToken, "050-8100003");
    expect(await ownerOf(orphan)).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and type = 'lead_new'", [orphan]))).toBeGreaterThan(0);
    await clearLeaves();
    // away with no deputy: no owner
    await asAdmin((q) => q("update public.member_leaves set starts_on = current_date - 1, ends_on = current_date + 1 where id = $1", [leave]));
    expect(await ownerOf(await submit(formToken, "050-8100004"))).toBeNull();
    await clearLeaves();
  });

  it("back from the absence, the form's owner gets the leads nobody took, as new leads (HEB-08 follow-up)", async () => {
    await clearLeaves();
    const runReturn = () => asAdmin(async (q) => (await q<{ n: number }>("select app.return_absence_leads() as n")).rows[0].n);
    const marker = (lead: string) =>
      asAdmin(async (q) => (await q<{ outcome: string | null; absent_user_id: string; form_id: string }>("select outcome, absent_user_id, form_id from app.absence_waiting_leads where lead_id = $1", [lead])).rows[0]);
    const leave = await absent(away, null);
    const waiting = await submit(formToken, "050-8150001");
    const taken = await submit(formToken, "050-8150002");
    const outOfHours = await submit(formToken, "050-8150003");
    expect(await ownerOf(waiting)).toBeNull();
    expect(await marker(waiting)).toMatchObject({ outcome: null, absent_user_id: away.id });
    // still away: nothing moves
    await runReturn();
    expect(await ownerOf(waiting)).toBeNull();
    // someone takes one meanwhile
    await asAdmin((q) => q("update public.leads set owner_id = $2 where id = $1", [taken, rep3.id]));
    // back today (the leave ended yesterday), but outside their own working hours: waits
    await asAdmin(async (q) => {
      await q("update public.member_leaves set starts_on = current_date - 10, ends_on = (now() at time zone 'Asia/Jerusalem')::date - 1 where id = $1", [leave]);
      await q("update public.profiles set working_hours = '{}'::jsonb where id = $1", [away.id]);
      await q("update app.absence_waiting_leads set next_check_at = now() where lead_id = any($1)", [[waiting, taken, outOfHours]]);
    });
    await runReturn();
    expect(await ownerOf(waiting)).toBeNull();
    expect((await marker(taken)).outcome).toBe("taken");
    expect(await ownerOf(taken)).toBe(rep3.id);
    // in hours (no hours set anywhere): handed back, told as a new lead
    await asAdmin(async (q) => {
      await q("update public.profiles set working_hours = null where id = $1", [away.id]);
      await q("update app.absence_waiting_leads set next_check_at = now() where lead_id = any($1)", [[waiting, outOfHours]]);
    });
    expect(await runReturn()).toBe(2);
    expect(await ownerOf(waiting)).toBe(away.id);
    expect(await ownerOf(outOfHours)).toBe(away.id);
    expect((await marker(waiting)).outcome).toBe("returned");
    const told = await asAdmin(async (q) =>
      (await q<{ type: string }>("select type from public.notifications where user_id = $1 and entity_id = $2 order by created_at", [away.id, waiting])).rows.map((r) => r.type),
    );
    expect(told).toEqual(["lead_new"]);
    // back already: the owner gets a new lead directly, with no marker
    const direct = await submit(formToken, "050-8150004");
    expect(await ownerOf(direct)).toBe(away.id);
    expect(await asAdmin((q) => count(q, "select 1 from app.absence_waiting_leads where lead_id = $1", [direct]))).toBe(0);
    // a person who left the business: given up
    await clearLeaves();
    await absent(away, null);
    const gone = await submit(formToken, "050-8150005");
    await clearLeaves();
    await asAdmin(async (q) => {
      await q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, away.id]);
      await q("update app.absence_waiting_leads set next_check_at = now() where lead_id = $1", [gone]);
    });
    await runReturn();
    expect((await marker(gone)).outcome).toBe("member_gone");
    expect(await ownerOf(gone)).toBeNull();
    await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, away.id]));
    // the marker table is not reachable from the API roles
    expect((await pgError(asUser(owner.id, (q) => q("select 1 from app.absence_waiting_leads")))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select app.return_absence_leads()")))).code).toBe("42501");
  });

  it("the round robin: an absent member's turn goes to the deputy (their turn is used, not the deputy's); no usable deputy = skipped", async () => {
    await clearLeaves();
    await order([away, rep3, deputy]);
    await absent(away, deputy);
    const deputyTurn = await pointer(deputy);
    const awayTurn = await pointer(away);
    const lead = await submit(rotationToken, "050-8200001");
    expect(await ownerOf(lead)).toBe(deputy.id);
    expect(await pointer(deputy)).toBe(deputyTurn);
    expect(await pointer(away)).not.toBe(awayTurn);
    // next in line: rep3
    expect(await ownerOf(await submit(rotationToken, "050-8200002"))).toBe(rep3.id);
    // the deputy away too: the absent member is skipped, as before HEB-08
    await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, current_date - 1, current_date + 1)", [org, deputy.id]));
    await order([away, rep3]);
    expect(await ownerOf(await submit(rotationToken, "050-8200003"))).toBe(rep3.id);
    // the deputy outside working hours: skipped too (the rotation never gives a lead outside hours)
    await clearLeaves();
    await absent(away, deputy);
    await asAdmin((q) => q("update public.profiles set working_hours = '{}'::jsonb where id = $1", [deputy.id]));
    await order([away, rep3]);
    expect(await ownerOf(await submit(rotationToken, "050-8200004"))).toBe(rep3.id);
    await asAdmin((q) => q("update public.profiles set working_hours = null where id = $1", [deputy.id]));
    await clearLeaves();
  });

  it("an automation that gives a lead to the absent person gives it to the deputy; a round robin step too", async () => {
    await clearLeaves();
    const rule = (actions: unknown[]) =>
      asUser(owner.id, async (q) =>
        (await q<{ id: string }>("insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'שיוך', 'lead', 'created', $2, false) returning id", [org, JSON.stringify(actions)])).rows[0].id,
      );
    const toAway = await rule([{ type: "assign_owner", mode: "user", user_id: away.id }]);
    const roundRobin = await rule([{ type: "assign_owner", mode: "round_robin", team_id: team }]);
    const lead = await insertLead(owner.id, org, { full_name: "ליד לשיוך", owner_id: owner.id });
    const run = (id: string) => asUser(owner.id, async (q) => (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [id, lead])).rows[0].r.status);
    expect(await run(toAway)).toBe("success");
    expect(await ownerOf(lead)).toBe(away.id);
    await absent(away, deputy);
    expect(await run(toAway)).toBe("success");
    expect(await ownerOf(lead)).toBe(deputy.id);
    await order([away, rep3]);
    await asAdmin((q) => q("update public.leads set owner_id = $2 where id = $1", [lead, owner.id]));
    expect(await run(roundRobin)).toBe("success");
    expect(await ownerOf(lead)).toBe(deputy.id);
    // no usable deputy (owner, 14 October 2026): never given to the absent person
    const lastSteps = (id: string) =>
      asAdmin(async (q) => (await q<{ steps: Array<{ action: string; status: string; warning?: string }> }>("select steps from public.automation_runs where automation_id = $1 order by created_at desc limit 1", [id])).rows[0].steps);
    await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, current_date - 1, current_date + 1)", [org, deputy.id]));
    // a lead that has an owner keeps it
    expect(await run(toAway)).toBe("success");
    expect(await ownerOf(lead)).toBe(deputy.id);
    expect(await lastSteps(toAway)).toEqual([{ action: "assign_owner", status: "ok", warning: "the owner is away, the lead has no owner" }]);
    // a lead with no owner stays unowned: whoever may take it is told, and it waits for the person's return
    const unowned = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.leads (organization_id, status_id, full_name, team_id) values ($1, (select id from public.lead_statuses where organization_id = $1 and kind = 'open' order by is_default desc, position limit 1), 'ליד בלי אחראי', $2) returning id", [org, team])).rows[0].id,
    );
    expect(await ownerOf(unowned)).toBeNull();
    const runOn = (id: string, leadId: string) => asUser(owner.id, async (q) => (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [id, leadId])).rows[0].r.status);
    expect(await runOn(toAway, unowned)).toBe("success");
    expect(await ownerOf(unowned)).toBeNull();
    expect(await lastSteps(toAway)).toEqual([{ action: "assign_owner", status: "ok", warning: "the owner is away, the lead has no owner" }]);
    const told = await asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.notifications where entity_id = $1 and type = 'lead_new'", [unowned])).rows.map((r) => r.user_id));
    expect(told.length).toBeGreaterThan(0);
    expect(told).not.toContain(away.id);
    expect(await asAdmin(async (q) => (await q<{ a: string; f: string | null; o: string | null }>("select absent_user_id as a, form_id as f, outcome as o from app.absence_waiting_leads where lead_id = $1", [unowned])).rows[0])).toEqual({ a: away.id, f: null, o: null });
    // back on the return day: handed to them as a new lead
    await clearLeaves();
    await asAdmin((q) => q("update app.absence_waiting_leads set next_check_at = now() where lead_id = $1", [unowned]));
    await asAdmin((q) => q("select app.return_absence_leads()"));
    expect(await ownerOf(unowned)).toBe(away.id);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and user_id = $2 and type = 'lead_new'", [unowned, away.id]))).toBe(1);
    // present again: the automation gives it to them directly, with no warning
    await asAdmin((q) => q("update public.leads set owner_id = $2 where id = $1", [lead, owner.id]));
    expect(await run(toAway)).toBe("success");
    expect(await ownerOf(lead)).toBe(away.id);
    expect(await lastSteps(toAway)).toEqual([{ action: "assign_owner", status: "ok" }]);
    await clearLeaves();
  });

  describe("what the deputy reads and works", () => {
    let open1: string, answered: string, ownCall: string, closedLead: string, repLead: string;
    let linked: string, unlinked: string, doneLinked: string, company: string;
    let awayTask: string, repTask: string;
    let leaveId: string;

    beforeAll(async () => {
      await clearLeaves();
      open1 = await insertLead(owner.id, org, { full_name: "פתוח שלא נענה", owner_id: away.id });
      answered = await insertLead(owner.id, org, { full_name: "נענה", owner_id: away.id });
      ownCall = await insertLead(owner.id, org, { full_name: "ממלא המקום התקשר", owner_id: away.id });
      repLead = await insertLead(owner.id, org, { full_name: "של נציג אחר", owner_id: rep3.id });
      closedLead = await insertLead(owner.id, org, { full_name: "סגור", owner_id: away.id });
      await asAdmin(async (q) => {
        await q("update public.leads set status_id = (select id from public.lead_statuses where organization_id = $1 and kind = 'disqualified' limit 1), disqualify_reason = null where id = $2", [org, closedLead]);
        // the absent person answered this one before leaving
        await q("insert into public.activities (organization_id, type, body, lead_id, created_by) values ($1, 'call', 'דיברנו', $2, $3)", [org, answered, away.id]);
      });
      // linked records the absent person reads themselves ('own' visibility: their own)
      linked = await contact("מקושר", away.id);
      unlinked = await contact("לא מקושר", owner.id);
      doneLinked = await contact("משימה שנסגרה", away.id);
      company = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.companies (organization_id, name, owner_id) values ($1, 'חברה מקושרת', $2) returning id", [org, away.id])).rows[0].id);
      awayTask = await task(away.id, { contact_id: linked, company_id: company });
      await task(away.id, { contact_id: doneLinked }, { status: "done" });
      repTask = await task(rep3.id, { contact_id: unlinked });
      leaveId = await absent(away, deputy, "reserve");
      // the deputy's own call on a waiting lead: it stays in view for them
      await asUser(deputy.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'חזרתי', $2)", [org, ownCall]));
    });

    it("reads the linked records and the unanswered open leads, nothing else, even with 'own' visibility", async () => {
      expect(await sees(deputy, "leads", open1)).toBe(true);
      expect(await sees(deputy, "leads", ownCall)).toBe(true);
      expect(await sees(deputy, "leads", answered)).toBe(false);
      expect(await sees(deputy, "leads", closedLead)).toBe(false);
      expect(await sees(deputy, "leads", repLead)).toBe(false);
      expect(await sees(deputy, "contacts", linked)).toBe(true);
      expect(await sees(deputy, "companies", company)).toBe(true);
      expect(await sees(deputy, "contacts", unlinked)).toBe(false);
      expect(await sees(deputy, "contacts", doneLinked)).toBe(false);
      // the absent person's tasks: open ones, and one changed during the absence
      expect(await sees(deputy, "tasks", awayTask)).toBe(true);
      expect(await sees(deputy, "tasks", repTask)).toBe(false);
      // the timeline of a lead they read follows
      expect(await asUser(deputy.id, (q) => count(q, "select 1 from public.activities where lead_id = $1", [ownCall]))).toBe(1);
      // a colleague who covers for nobody sees none of it
      expect(await sees(rep3, "leads", open1)).toBe(false);
      expect(await sees(rep3, "contacts", linked)).toBe(false);
      expect(await sees(rep3, "tasks", awayTask)).toBe(false);
      // the per-user mirror says the same
      const mirror = (type: string, id: string) =>
        asAdmin(async (q) => (await q<{ ok: boolean }>("select app.user_deputy_reads($1, $2, $3, $4) as ok", [org, deputy.id, type, id])).rows[0].ok);
      expect(await mirror("lead", open1)).toBe(true);
      expect(await mirror("lead", answered)).toBe(false);
      expect(await mirror("contact", linked)).toBe(true);
      expect(await mirror("contact", unlinked)).toBe(false);
      expect(await mirror("task", awayTask)).toBe(true);
    });

    it("a record the absent person cannot read stays closed to the deputy, even when the absent person's open task links it", async () => {
      const { pipelineId, stages } = await defaultPipeline(org);
      const deal = await asUser(owner.id, async (q) =>
        (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה של הבעלים', $2, $3, $4) returning id", [org, pipelineId, stages[0].id, owner.id])).rows[0].id,
      );
      const hiddenTask = await task(away.id, { deal_id: deal });
      expect(await sees(away, "deals", deal)).toBe(false);
      expect(await sees(deputy, "deals", deal)).toBe(false);
      // the task itself is the absent person's, so the deputy sees it
      expect(await sees(deputy, "tasks", hiddenTask)).toBe(true);
      expect(await asAdmin(async (q) => (await q<{ ok: boolean }>("select app.user_deputy_reads($1, $2, 'deal', $3) as ok", [org, deputy.id, deal])).rows[0].ok)).toBe(false);
      await asAdmin((q) => q("update public.tasks set status = 'done' where id = $1", [hiddenTask]));
    });

    it("may complete, snooze and edit the absent person's open task, never hand it over or delete it", async () => {
      await asUser(deputy.id, async (q) => {
        expect((await q("update public.tasks set due_at = now() + interval '1 day', title = 'לחזור ללקוח מחר' where id = $1 returning id", [awayTask])).rowCount).toBe(1);
        // someone else's task: nothing
        expect((await q("update public.tasks set title = 'x' where id = $1 returning id", [repTask])).rowCount).toBe(0);
        // no WHERE clause: only the absent person's open tasks
        expect((await q("update public.tasks set priority = priority where organization_id = $1 returning id", [org])).rows.map((r) => r.id)).toEqual([awayTask]);
      });
      const handOver = await pgError(asUser(deputy.id, (q) => q("update public.tasks set owner_id = $2 where id = $1", [awayTask, deputy.id])));
      expect(handOver.code).toBe("42501");
      expect(handOver.hint).toBe("task:deputy_owner");
      expect((await pgError(asUser(deputy.id, (q) => q("update public.tasks set deleted_at = now() where id = $1", [awayTask])))).code).toBe("42501");
      expect(await asUser(deputy.id, async (q) => (await q("delete from public.tasks where id = $1", [awayTask])).rowCount)).toBe(0);
      // completing it keeps it in view (returning works), and its owner stays
      await asUser(deputy.id, async (q) => {
        expect((await q("update public.tasks set status = 'done' where id = $1 returning id", [awayTask])).rowCount).toBe(1);
      });
      expect(await asAdmin(async (q) => (await q<{ owner_id: string; status: string }>("select owner_id, status from public.tasks where id = $1", [awayTask])).rows[0])).toEqual({ owner_id: away.id, status: "done" });
      expect(await sees(deputy, "tasks", awayTask)).toBe(true);
      // done: no longer editable by the deputy, and its contact is no longer linked by an open task
      expect(await asUser(deputy.id, async (q) => (await q("update public.tasks set title = 'y' where id = $1 returning id", [awayTask])).rowCount)).toBe(0);
      expect(await sees(deputy, "contacts", linked)).toBe(false);
      await asAdmin((q) => q("update public.tasks set status = 'open' where id = $1", [awayTask]));
    });

    it("is reminded of the absent person's task, a notification only", async () => {
      await asAdmin((q) => q("update public.tasks set remind_at = now() - interval '1 minute', reminded_at = null where id = $1", [awayTask]));
      await asAdmin((q) => q("update public.tasks set reminded_at = now() where reminded_at is null and id <> $1", [awayTask]));
      await asAdmin((q) => q("select app.send_task_reminders()"));
      const sent = await asAdmin(async (q) =>
        (await q<{ user_id: string; body: string | null }>("select user_id, body from public.notifications where entity_id = $1 and type = 'task_reminder' order by user_id", [awayTask])).rows,
      );
      expect(sent.map((r) => r.user_id).sort()).toEqual([away.id, deputy.id].sort());
      expect(sent.find((r) => r.user_id === deputy.id)?.body).toBe("בשביל דנה הנעדרת");
      expect(sent.find((r) => r.user_id === away.id)?.body).toBeNull();
      expect(await asAdmin(async (q) => (await q<{ o: string }>("select owner_id as o from public.tasks where id = $1", [awayTask])).rows[0].o)).toBe(away.id);
    });

    it("can be mentioned on a record they read as a deputy, and not on one they do not", async () => {
      const before = await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'mention'", [deputy.id]));
      // (a note on a waiting lead would answer it; a contact the absent person's open task links stays readable)
      await asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, contact_id) values ($1, 'note', $2, $3)", [org, `${token(deputy)} תחזור אליו`, linked]));
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'mention'", [deputy.id]))).toBe(before + 1);
      const refused = await pgError(asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, contact_id) values ($1, 'note', $2, $3)", [org, `${token(deputy)} תחזור`, unlinked])));
      expect(refused.hint).toBe("mention:forbidden");
      // the picker on that lead lists the deputy, and works for the deputy
      expect(await asUser(owner.id, async (q) => (await q<{ user_id: string }>("select user_id from public.mention_candidates($1, 'lead', $2)", [org, open1])).rows.map((r) => r.user_id))).toContain(deputy.id);
      expect(await asUser(deputy.id, (q) => count(q, "select 1 from public.mention_candidates($1, 'lead', $2)", [org, open1]))).toBeGreaterThan(0);
    });

    it("no cross-organization access: a deputy who is also a member elsewhere sees nothing there, an outsider nothing here", async () => {
      const invite = await asUser(outsider.id, async (q) => (await q<{ token: string }>("select public.create_invitation($1, $2, 'member') as token", [otherOrg, deputy.email])).rows[0].token);
      await asUser(deputy.id, (q) => q("select public.accept_invitation($1)", [invite]));
      await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [otherOrg]));
      const foreignLead = await insertLead(outsider.id, otherOrg, { full_name: "ליד זר", owner_id: outsider.id });
      expect(await sees(deputy, "leads", foreignLead)).toBe(false);
      expect(await asUser(deputy.id, (q) => count(q, "select 1 from app.deputy_readable('lead') r where r.organization_id = $1", [otherOrg]))).toBe(0);
      expect(await sees(outsider, "leads", open1)).toBe(false);
      expect(await sees(outsider, "tasks", awayTask)).toBe(false);
      expect(await asUser(outsider.id, async (q) => (await q("update public.tasks set title = 'x' where id = $1 returning id", [awayTask])).rowCount)).toBe(0);
      // the engine helpers are not reachable from the API roles
      expect((await pgError(asUser(deputy.id, (q) => q("select app.deputy_for($1, $2, now())", [org, away.id])))).code).toBe("42501");
      expect((await pgError(asUser(deputy.id, (q) => q("select * from app.deputy_records($1, 'lead', false)", [away.id])))).code).toBe("42501");
      expect((await pgError(asUser(deputy.id, (q) => q("select app.user_deputy_reads($1, $2, 'lead', $3)", [org, deputy.id, open1])))).code).toBe("42501");
    });

    it("the access ends with the absence (and does not start before it)", async () => {
      // ended yesterday
      await asAdmin((q) => q("update public.member_leaves set starts_on = current_date - 5, ends_on = (now() at time zone 'Asia/Jerusalem')::date - 1 where id = $1", [leaveId]));
      expect(await sees(deputy, "leads", open1)).toBe(false);
      expect(await sees(deputy, "contacts", linked)).toBe(false);
      expect(await sees(deputy, "tasks", awayTask)).toBe(false);
      expect(await asUser(deputy.id, async (q) => (await q("update public.tasks set title = 'z' where id = $1 returning id", [awayTask])).rowCount)).toBe(0);
      // starts tomorrow
      await asAdmin((q) => q("update public.member_leaves set starts_on = (now() at time zone 'Asia/Jerusalem')::date + 1, ends_on = (now() at time zone 'Asia/Jerusalem')::date + 3 where id = $1", [leaveId]));
      expect(await sees(deputy, "leads", open1)).toBe(false);
      // a suspended deputy reads nothing as a deputy
      await asAdmin((q) => q("update public.member_leaves set starts_on = current_date - 1, ends_on = current_date + 1 where id = $1", [leaveId]));
      expect(await sees(deputy, "leads", open1)).toBe(true);
      await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, deputy.id]));
      expect(await asAdmin(async (q) => (await q<{ ok: boolean }>("select app.user_deputy_reads($1, $2, 'lead', $3) as ok", [org, deputy.id, open1])).rows[0].ok)).toBe(false);
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, deputy.id]));
      expect(await sees(deputy, "leads", open1)).toBe(true);
      // a deputy who became a viewer reads nothing as a deputy
      await asAdmin((q) => q("update public.memberships set role = 'viewer', seat_type = 'view' where organization_id = $1 and user_id = $2", [org, deputy.id]));
      expect(await sees(deputy, "leads", open1)).toBe(false);
      expect(await sees(deputy, "contacts", linked)).toBe(false);
      expect(await sees(deputy, "tasks", awayTask)).toBe(false);
      await asAdmin((q) => q("update public.memberships set role = 'member', seat_type = 'full' where organization_id = $1 and user_id = $2", [org, deputy.id]));
      expect(await sees(deputy, "leads", open1)).toBe(true);
      // the absent person no longer an active member: nothing
      await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, away.id]));
      expect(await sees(deputy, "leads", open1)).toBe(false);
      expect(await sees(deputy, "contacts", linked)).toBe(false);
      expect(await sees(deputy, "tasks", awayTask)).toBe(false);
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, away.id]));
      await clearLeaves();
    });
  });

  it("passing a lead on (SPD-03) gives the absent member's turn to the deputy and stamps the absent member's turn", async () => {
    await clearLeaves();
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"auto_reassign\": true}'::jsonb where organization_id = $1", [org]));
    await asUser(owner.id, (q) =>
      q(
        `insert into public.lead_response_settings (organization_id, breach_action, max_passes) values ($1, 'pass_on', 2)
         on conflict (organization_id) do update set breach_action = excluded.breach_action, max_passes = excluded.max_passes`,
        [org],
      ),
    );
    await order([rep3, away]);
    const lead = await submit(rotationToken, "050-8300001");
    expect(await ownerOf(lead)).toBe(rep3.id);
    await absent(away, deputy);
    await order([rep3, away]);
    const awayTurn = await pointer(away);
    const deputyTurn = await pointer(deputy);
    await asAdmin(async (q) => {
      await q("update app.lead_response_checks set next_check_at = now() + interval '1 hour' where resolved_at is null and lead_id <> $1", [lead]);
      await q("update app.lead_response_checks set window_start = now() - interval '2 hours', next_check_at = now() where lead_id = $1", [lead]);
      await q("select app.check_lead_responses()");
    });
    // rep3 (the previous owner) is skipped and keeps their turn; the absent member's turn gives it to the deputy
    expect(await ownerOf(lead)).toBe(deputy.id);
    expect(await pointer(away)).not.toBe(awayTurn);
    expect(await pointer(deputy)).toBe(deputyTurn);
    await clearLeaves();
  });

  it("passing on reaches a free member past two absent members whose deputy is the current owner (review)", async () => {
    await clearLeaves();
    // rotation: away, admin (both away, deputy = the current owner), then rep3
    await asUser(owner.id, (q) => q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3) on conflict do nothing", [org, team, admin.id]));
    await order([away, rep3, admin]);
    await absent(away, deputy);
    const lead = await submit(rotationToken, "050-8300002");
    expect(await ownerOf(lead)).toBe(deputy.id);
    await absent(admin, deputy);
    await order([away, admin, rep3]);
    const rep3Turn = await pointer(rep3);
    await asAdmin(async (q) => {
      await q("update app.lead_response_checks set next_check_at = now() + interval '1 hour' where resolved_at is null and lead_id <> $1", [lead]);
      await q("update app.lead_response_checks set window_start = now() - interval '2 hours', next_check_at = now() where lead_id = $1", [lead]);
      await q("select app.check_lead_responses()");
    });
    expect(await ownerOf(lead)).toBe(rep3.id);
    expect(await pointer(rep3)).not.toBe(rep3Turn);
    await asUser(owner.id, (q) => q("delete from public.team_members where organization_id = $1 and team_id = $2 and user_id = $3", [org, team, admin.id]));
    await clearLeaves();
  });
});
