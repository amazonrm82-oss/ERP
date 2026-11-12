import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// MNY-06 part one: report_monthly_summary counts what the system did in a month, counts only, for owners and admins.
describe("monthly summary (MNY-06)", () => {
  let owner: U, admin: U, manager: U, member: U, other: U;
  let org: string, otherOrg: string;

  const summary = (as: U, orgId: string = org, month: string | null = null) =>
    asUser(as.id, async (q) => (await q<{ r: Record<string, unknown> }>("select public.report_monthly_summary($1, $2::date) as r", [orgId, month])).rows[0].r);

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "admin");
    manager = await addMember(org, owner.id, "manager", "manager");
    member = await addMember(org, owner.id, "member", "rep");
    other = await createUser("other");
    otherOrg = await createOrg(other.id, "עסק אחר");
  });

  it("answers only owners and admins of the business, and an empty month is all zeros", async () => {
    expect(await summary(manager)).toEqual({ allowed: false });
    expect(await summary(member)).toEqual({ allowed: false });
    expect(await summary(other)).toEqual({ allowed: false });
    const empty = await summary(admin);
    expect(empty).toMatchObject({
      allowed: true,
      leads_distributed: 0,
      automation_tasks: 0,
      reminder_tasks: { collection: 0, signature: 0, contract_renewal: 0 },
      collected_after_reminder: { window_days: 14, documents: 0, payments: 0 },
    });
    expect(empty.customer_messages).toEqual({
      collection: { queued: 0, sent: 0 },
      meeting_reminder: { queued: 0, sent: 0 },
      instant_reply: { queued: 0, sent: 0 },
      review_request: { queued: 0, sent: 0 },
    });
    // the month is the first day of the business's current month
    expect(String(empty.month)).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it("the count helper answers nothing to anyone but owners and admins, and anon cannot run either function", async () => {
    const helper = (as: U, orgId: string) =>
      asUser(as.id, async (q) =>
        (await q<{ r: unknown }>("select app.monthly_summary_counts($1, now() - interval '1 month', now(), current_date - 31, current_date + 1, 'Asia/Jerusalem') as r", [orgId])).rows[0].r,
      );
    expect(await helper(member, org)).toBeNull();
    expect(await helper(manager, org)).toBeNull();
    expect(await helper(other, org)).toBeNull();
    expect(await helper(owner, org)).not.toBeNull();
    expect((await pgError(asAnon((q) => q("select public.report_monthly_summary($1)", [org])))).code).toBe("42501");
    expect(
      (await pgError(asAnon((q) => q("select app.monthly_summary_counts($1, now(), now(), current_date, current_date, 'UTC')", [org])))).code,
    ).toBe("42501");
  });

  it("refuses a month in the future", async () => {
    const error = await pgError(summary(owner, org, "2999-01-01"));
    expect(error.code).toBe("22023");
    expect(error.hint).toBe("report:month");
  });

  it("counts leads that got an owner with no person deciding, each once", async () => {
    // a lead the server made with an owner (intake's way: no session), later handed over by a person: counted once
    const madeByServer = await asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.leads (organization_id, status_id, full_name, owner_id) select $1, s.id, 'מהטופס', $2 from public.lead_statuses s where s.organization_id = $1 and s.is_default returning id",
          [org, member.id],
        )
      ).rows[0].id,
    );
    await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [madeByServer, admin.id]));
    // the server moved it again (rotation, pass-on): still the same lead
    await asAdmin((q) => q("update public.leads set owner_id = $2 where id = $1", [madeByServer, member.id]));
    // a lead a person made and gave: not counted
    const byPerson = await insertLead(owner.id, org, { full_name: "ידני", owner_id: member.id });
    await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [byPerson, admin.id]));
    // a lead a person made, then the server gave it an owner: counted
    const passedOn = await insertLead(owner.id, org, { full_name: "הועבר" });
    await asAdmin((q) => q("update public.leads set owner_id = $2 where id = $1", [passedOn, member.id]));
    // a server-made lead with no owner: not counted, also after a person took it or gave it to someone
    const unowned = await asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.leads (organization_id, status_id, full_name) select $1, s.id, 'בלי אחראי' from public.lead_statuses s where s.organization_id = $1 and s.is_default returning id",
          [org],
        )
      ).rows[0].id,
    );
    await asUser(member.id, (q) => q("select public.take_lead($1, $2)", [org, unowned]));
    const unownedAssigned = await asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.leads (organization_id, status_id, full_name) select $1, s.id, 'שובץ ידנית' from public.lead_statuses s where s.organization_id = $1 and s.is_default returning id",
          [org],
        )
      ).rows[0].id,
    );
    await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [unownedAssigned, member.id]));
    expect(await asAdmin(async (q) => (await q<{ owner_id: string }>("select owner_id from public.leads where id = $1", [unowned])).rows[0].owner_id)).toBe(member.id);
    expect((await summary(owner)).leads_distributed).toBe(2);
    // a lead in the recycle bin still counts
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [madeByServer]));
    expect((await summary(owner)).leads_distributed).toBe(2);
    // another business's owner learns nothing
    expect(await summary(other)).toEqual({ allowed: false });
    expect((await summary(other, otherOrg)).leads_distributed).toBe(0);
  });

  it("counts tasks an automation made, not tasks a person made", async () => {
    // the leads of the earlier tests are handled first, so the rule meets only its own lead
    await asAdmin((q) => q("select app.process_outbox(5000)"));
    const before = Number((await summary(owner)).automation_tasks);
    await asUser(owner.id, (q) =>
      q(
        `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions)
         values ($1, 'משימה לליד', 'lead', 'created', '{}', '[]', $2)`,
        [org, JSON.stringify([{ type: "create_task", title: "לחזור", due_in_minutes: 15 }])],
      ),
    );
    await insertLead(member.id, org, { full_name: "ליד לאוטומציה" });
    await asAdmin((q) => q("select app.process_outbox(5000)"));
    await asAdmin((q) => q("select app.process_outbox(5000)"));
    await asUser(owner.id, (q) => q("insert into public.tasks (organization_id, title) values ($1, 'ידנית')", [org]));
    expect(Number((await summary(owner)).automation_tasks) - before).toBe(1);
    await asUser(owner.id, (q) => q("update public.automations set is_active = false where organization_id = $1", [org]));
  });

  it("counts queued customer messages by type, and collection reminder tasks", async () => {
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email) values ($1, 'לקוחה', 'c@example.test') returning id", [org])).rows[0].id,
    );
    const lead = await insertLead(owner.id, org, { full_name: "פונה", email: "l@example.test" });
    const rule = "00000000-0000-4000-8000-000000000346";
    await asAdmin(async (q) => {
      const job = (kind: string, record: Record<string, string>, status = "queued") =>
        q("insert into app.jobs (organization_id, kind, payload, status) values ($1, 'message.send', $2, $3)", [
          org,
          JSON.stringify({ channel: "email", message_type: kind, ...record }),
          status,
        ]);
      await job("instant_reply", { lead_id: lead });
      await job("instant_reply", { lead_id: lead });
      await job("instant_reply", { lead_id: lead }, "refused");
      await job("requested_document", { contact_id: contact });
      await job("collection", { contact_id: contact });
      // a person's card send or button press is not the system's work
      await job("collection", { contact_id: contact, channel: "sms", sent_by_user_id: owner.id });
      await job("collection", { contact_id: contact, automation_id: rule, pressed_by_user_id: owner.id });
      await job("instant_reply", { lead_id: lead, reply_to_user_id: owner.id });
      // a rule's own send (no person pressed it) is the system's work
      await job("collection", { contact_id: contact, automation_id: rule });
      // another business's jobs are not counted
      await q("insert into app.jobs (organization_id, kind, payload) values ($1, 'message.send', $2)", [
        otherOrg,
        JSON.stringify({ channel: "email", message_type: "instant_reply", lead_id: lead }),
      ]);
    });
    const result = await summary(owner);
    expect(result.customer_messages).toMatchObject({
      instant_reply: { queued: 2, sent: 0 },
      collection: { queued: 2, sent: 0 },
      meeting_reminder: { queued: 0 },
    });
  });

  it("counts a debt paid within 14 days after a collection reminder, not one paid without a recent reminder", async () => {
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'חייב') returning id", [org])).rows[0].id,
    );
    const docWith = (number: string) =>
      asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, 'tax_invoice', $3, current_date - 40, 5000, current_date - 30) returning id",
            [org, contact, number],
          )
        ).rows[0].id,
      );
    const reminded = await docWith("MS-1");
    const stale = await docWith("MS-2");
    const never = await docWith("MS-3");
    const noReminder = await docWith("MS-4");
    const sameDayAfter = await docWith("MS-5");
    const sameDayBefore = await docWith("MS-6");
    const pay = (doc: string) =>
      asUser(owner.id, async (q) => {
        const payment = (
          await q<{ id: string }>(
            "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 5000, (now() at time zone 'Asia/Jerusalem')::date, 'transfer') returning id",
            [org, contact],
          )
        ).rows[0].id;
        await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 5000)", [org, payment, doc]);
      });
    const task = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, contact_id) values ($1, 'תזכורת', $2) returning id", [org, contact])).rows[0].id,
    );
    await asAdmin(async (q) => {
      // a reminder two days ago (with its task), and one 20 days ago
      await q(
        "insert into app.collection_reminders_sent (organization_id, document_id, due_date, offset_days, task_id, done_at) values ($1, $2, current_date - 30, 0, $3, now() - interval '2 days')",
        [org, reminded, task],
      );
      await q(
        "insert into app.collection_reminders_sent (organization_id, document_id, due_date, offset_days, customer_outcome, done_at) values ($1, $2, current_date - 30, 7, 'sent', now() - interval '20 days')",
        [org, stale],
      );
    });
    const stage = (doc: string, offset: number, doneAgo: string, task: string | null, outcome: string | null) =>
      asAdmin((q) =>
        q(
          "insert into app.collection_reminders_sent (organization_id, document_id, due_date, offset_days, task_id, customer_outcome, done_at) values ($1, $2, current_date - 30, $3, $4, $5, now() - $6::interval)",
          [org, doc, offset, task, outcome, doneAgo],
        ),
      );
    // the same task moved to a later stage: one task
    await stage(reminded, -3, "5 days", task, null);
    // a stage that reminded nobody (no task, no message): not a reminder
    await stage(noReminder, 0, "2 days", null, "no_address");
    // the same day: a payment recorded after the reminder counts, one recorded before it does not
    await stage(sameDayAfter, 0, "0 seconds", null, "sent");
    await pay(reminded);
    await pay(stale);
    await pay(never);
    await pay(noReminder);
    await pay(sameDayAfter);
    await pay(sameDayBefore);
    await stage(sameDayBefore, 0, "0 seconds", null, "queued");
    const result = await summary(owner);
    expect(result.collected_after_reminder).toEqual({ window_days: 14, documents: 2, payments: 2 });
    // distinct tasks created this month that a collection stage gave
    expect((result.reminder_tasks as { collection: number }).collection).toBe(1);
    // a cancelled payment does not count
    await asAdmin((q) => q("update public.payments set status = 'cancelled', cancel_reason = 'טעות' where organization_id = $1 and contact_id = $2", [org, contact]));
    expect((await summary(owner)).collected_after_reminder).toEqual({ window_days: 14, documents: 0, payments: 0 });
  });
});
