import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Ev = { entity_type: string; entity_id: string; event_type: string; actor_id: string | null; payload: Record<string, unknown> };

/**
 * AUT-04: commercial automation triggers. A quote's status moving to viewed / accepted / rejected / expired, a recorded
 * document and a meeting scheduled / cancelled / no-show each write one outbox event per linked record (origin
 * 'automation' only while an automation runs); rules of the new types run from the outbox, only while the business has the
 * plan flag the trigger needs; an AUT-06 retry runs only while the quote, document or meeting is still in that state.
 * Lead's choices pending the owner: only the first meeting of a series is "scheduled"; quotes start deal and contact rules;
 * "document" = a document recorded from outside; no amount filter on quotes.
 */
describe("commercial automation triggers (AUT-04)", () => {
  let owner: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const own = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const insert = (sql: string, params: unknown[]) => own(async (q) => (await one<{ id: string }>(q, sql, params)).id);
  const newContact = () => insert("insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, `איש ${++n}`, owner.id]);
  const newDeal = (contact: string | null) =>
    insert("insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id) values ($1, $2, $3, $4, $5, $6) returning id", [
      org,
      `עסקה ${++n}`,
      pipelineId,
      stageId,
      owner.id,
      contact,
    ]);
  const events = (type: string, key: string, id: string) =>
    asAdmin(
      async (q) =>
        (
          await q<Ev>(
            `select entity_type, entity_id, event_type, actor_id, payload from public.outbox_events
              where event_type = $1 and payload ->> $2 = $3 order by id`,
            [type, key, id],
          )
        ).rows,
    );
  const sentQuote = async (withDeal = true) => {
    const contact = await newContact();
    const deal = withDeal ? await newDeal(contact) : null;
    const quote = await insert("insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'הצעה', $2, $3) returning id", [org, deal, contact]);
    await own((q) => q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 50000)", [org, quote]));
    await own((q) => q("select public.quote_send($1, $2)", [org, quote]));
    return { quote, deal, contact };
  };
  // a server path moving the status (as the customer's page, the decide function and the job do)
  const serverStatus = (quote: string, status: string, automation = false) =>
    asAdmin(async (q) => {
      if (automation) await q("select set_config('app.automation_running', 'on', true)");
      await q("update public.quotes set status = $2 where id = $1", [quote, status]);
    });
  const rule = (entity: string, trigger: string, active = true) =>
    insert(
      `insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [org, `כלל ${++n}`, entity, trigger, JSON.stringify([{ type: "notify", to: "owner", title: `אוטומציה ${n}` }]), active],
    );
  const runsOf = (auto: string, record: string) => asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1 and entity_id = $2", [auto, record]));
  // process_outbox is shared by every test file: run it until this event is done
  const process = async (type: string, key: string, id: string) => {
    for (let i = 0; i < 50; i += 1) {
      await asAdmin((q) => q("select app.process_outbox(5000)"));
      const left = await asAdmin((q) =>
        count(q, "select 1 from public.outbox_events where event_type = $1 and payload ->> $2 = $3 and processed_at is null", [type, key, id]),
      );
      if (left === 0) return;
      await asAdmin((q) => q("select pg_sleep(0.1)"));
    }
    throw new Error("events were not processed");
  };
  const meeting = (fields: Record<string, unknown>) =>
    own(async (q) => {
      const row: Record<string, unknown> = {
        organization_id: org,
        title: "פגישה",
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
        ends_at: new Date(Date.now() + 90_000_000).toISOString(),
        ...fields,
      };
      const cols = Object.keys(row);
      return (await one<{ id: string }>(q, `insert into public.meetings (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row))).id;
    });

  beforeAll(async () => {
    owner = await createUser("ct-owner");
    org = await createOrg(owner.id, "עסק הטריגרים");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: true, documents: true, payments: true })]),
    );
    await own((q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
  });

  it("a quote's status change writes one event for its deal and one for its contact, on server paths too", async () => {
    const { quote, deal, contact } = await sentQuote();
    // sending writes nothing
    expect(await asAdmin((q) => count(q, "select 1 from public.outbox_events where payload ->> 'quote_id' = $1", [quote]))).toBe(0);
    await serverStatus(quote, "viewed");
    const viewed = await events("quote_viewed", "quote_id", quote);
    expect(viewed.map((e) => [e.entity_type, e.entity_id])).toEqual([
      ["deal", deal],
      ["contact", contact],
    ]);
    // the customer's page has no session: no actor
    expect(viewed.every((e) => e.actor_id === null && e.payload.status === "viewed" && e.payload.origin === undefined)).toBe(true);
    expect(viewed[0].payload.number).toBeTruthy();
    await serverStatus(quote, "accepted");
    expect(await events("quote_accepted", "quote_id", quote)).toHaveLength(2);

    const declined = await sentQuote();
    await serverStatus(declined.quote, "rejected");
    expect((await events("quote_declined", "quote_id", declined.quote)).map((e) => e.entity_type)).toEqual(["deal", "contact"]);

    // the expiry job's path
    const old = await sentQuote(false);
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(
        `update public.quotes q set valid_until = (now() at time zone app.intake_zone(o.timezone))::date - 1, quote_date = (now() at time zone app.intake_zone(o.timezone))::date - 2
           from public.organizations o where o.id = q.organization_id and q.id = $1`,
        [old.quote],
      );
    });
    await asAdmin((q) => q("select app.expire_quotes()"));
    expect((await events("quote_expired", "quote_id", old.quote)).map((e) => [e.entity_type, e.entity_id])).toEqual([["contact", old.contact]]);

    // cancelling writes none; a change made while an automation runs is marked
    const cancelled = await sentQuote();
    await own((q) => q("select public.quote_cancel($1, $2)", [org, cancelled.quote]));
    expect(await asAdmin((q) => count(q, "select 1 from public.outbox_events where payload ->> 'quote_id' = $1", [cancelled.quote]))).toBe(0);
    const marked = await sentQuote();
    await serverStatus(marked.quote, "viewed", true);
    expect((await events("quote_viewed", "quote_id", marked.quote)).every((e) => e.payload.origin === "automation")).toBe(true);
  });

  it("quote rules run from the outbox, and only while the business has the quotes flag", async () => {
    const dealRule = await rule("deal", "quote_accepted");
    const contactRule = await rule("contact", "quote_accepted");
    const { quote, deal, contact } = await sentQuote();
    await serverStatus(quote, "accepted");
    await process("quote_accepted", "quote_id", quote);
    expect([await runsOf(dealRule, deal!), await runsOf(contactRule, contact)]).toEqual([1, 1]);

    // the plan loses quotes: the next event runs no quote rule (the quote was sent before the flag went)
    const second = await sentQuote();
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: false, documents: true, payments: true })]));
    try {
      await serverStatus(second.quote, "accepted");
      await process("quote_accepted", "quote_id", second.quote);
      expect(await runsOf(dealRule, second.deal!)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: true, documents: true, payments: true })]));
    }
    // a change made by an automation starts no rule
    const marked = await sentQuote();
    await serverStatus(marked.quote, "accepted", true);
    await process("quote_accepted", "quote_id", marked.quote);
    expect(await runsOf(dealRule, marked.deal!)).toBe(0);
    for (const id of [dealRule, contactRule]) await asAdmin((q) => q("update public.automations set is_active = false where id = $1", [id]));
  });

  it("\"quote accepted\" may ask for a minimum amount before VAT (owner's answer 4 ב); a value that is not a number is ignored", async () => {
    const rule_ = (config: Record<string, unknown>) =>
      insert(
        `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, actions)
         values ($1, $2, 'deal', 'quote_accepted', $3, $4) returning id`,
        [org, `סכום ${++n}`, JSON.stringify(config), JSON.stringify([{ type: "notify", to: "owner", title: `סכום ${n}` }])],
      );
    // the quote's line is 500 ₪ before VAT (net_total_agorot 50000)
    const below = await rule_({ min_agorot: 50001 });
    const at = await rule_({ min_agorot: 50000 });
    const none = await rule_({});
    const notNumber = await rule_({ min_agorot: "הרבה" });
    const { quote, deal } = await sentQuote();
    const net = await asAdmin(async (q) => (await one<{ n: string }>(q, "select net_total_agorot::text as n from public.quotes where id = $1", [quote])).n);
    expect(net).toBe("50000");
    await serverStatus(quote, "accepted");
    const [ev] = await events("quote_accepted", "quote_id", quote);
    expect(ev.payload.net_total_agorot).toBe(50000);
    await process("quote_accepted", "quote_id", quote);
    expect([await runsOf(below, deal!), await runsOf(at, deal!), await runsOf(none, deal!), await runsOf(notNumber, deal!)]).toEqual([0, 1, 1, 1]);
    const failed = await asAdmin((q) => count(q, "select 1 from public.outbox_events where event_type = 'quote_accepted' and payload ->> 'quote_id' = $1 and last_error is not null", [quote]));
    expect(failed).toBe(0);
    for (const id of [below, at, none, notNumber]) await asAdmin((q) => q("update public.automations set is_active = false where id = $1", [id]));
  });

  it("a recorded document writes one event per record; a cancel writes none; rules need the documents flag", async () => {
    const auto = await rule("deal", "document_recorded");
    const contact = await newContact();
    const deal = await newDeal(contact);
    const doc = await insert(
      "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, 'tax_invoice', $4, 117000) returning id",
      [org, deal, contact, `INV-${++n}`],
    );
    const evs = await events("document_recorded", "document_id", doc);
    expect(evs.map((e) => [e.entity_type, e.entity_id])).toEqual([
      ["deal", deal],
      ["contact", contact],
    ]);
    expect(evs[0].payload).toEqual({ document_id: doc, doc_type: "tax_invoice", amount_agorot: 117000 });
    await own((q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [doc]));
    expect(await events("document_recorded", "document_id", doc)).toHaveLength(2);
    await process("document_recorded", "document_id", doc);
    expect(await runsOf(auto, deal)).toBe(1);
    await asAdmin((q) => q("update public.automations set is_active = false where id = $1", [auto]));
  });

  it("meetings: scheduled, cancelled and no-show on every linked record; blocked time never; a series is scheduled once", async () => {
    const contact = await newContact();
    const deal = await newDeal(contact);
    const m = await meeting({ contact_id: contact, deal_id: deal });
    expect((await events("meeting_scheduled", "meeting_id", m)).map((e) => e.entity_type).sort()).toEqual(["contact", "deal"]);
    await own((q) => q("update public.meetings set title = 'שם אחר' where id = $1", [m]));
    expect(await events("meeting_scheduled", "meeting_id", m)).toHaveLength(2);
    await own((q) => q("update public.meetings set status = 'no_show' where id = $1", [m]));
    expect((await events("meeting_no_show", "meeting_id", m)).map((e) => e.entity_type).sort()).toEqual(["contact", "deal"]);
    const c = await meeting({ contact_id: contact });
    await own((q) => q("update public.meetings set status = 'cancelled' where id = $1", [c]));
    expect((await events("meeting_cancelled", "meeting_id", c)).map((e) => e.entity_type)).toEqual(["contact"]);

    // blocked time: never, whatever its status
    const block = await meeting({ is_block: true, meeting_type: "other", reminder_minutes: null });
    await own((q) => q("update public.meetings set status = 'cancelled' where id = $1", [block]));
    expect(await asAdmin((q) => count(q, "select 1 from public.outbox_events where payload ->> 'meeting_id' = $1", [block]))).toBe(0);

    // a weekly series: only the first meeting is "scheduled"; each meeting still has its own cancel
    const day = (w: number) => new Date(Date.now() + (w * 7 + 2) * 86_400_000);
    const times = [0, 1, 2].map((w) => ({ starts_at: day(w).toISOString(), ends_at: new Date(day(w).getTime() + 3_600_000).toISOString() }));
    const series = await own(async (q) =>
      (
        await one<{ r: { series_id: string; ids: string[] } }>(q, "select public.create_meeting_series($1, $2, $3, '{}'::uuid[]) as r", [
          org,
          JSON.stringify({ title: "סדרה", meeting_type: "in_person", contact_id: contact }),
          JSON.stringify(times),
        ])
      ).r,
    );
    const scheduled = await asAdmin((q) =>
      count(q, "select 1 from public.outbox_events where event_type = 'meeting_scheduled' and (payload ->> 'meeting_id')::uuid = any ($1::uuid[])", [series.ids]),
    );
    expect(scheduled).toBe(1);
    await own((q) => q("update public.meetings set status = 'cancelled' where id = $1", [series.ids[2]]));
    expect(await events("meeting_cancelled", "meeting_id", series.ids[2])).toHaveLength(1);
  });

  it("an AUT-06 retry runs only while the quote, document or meeting is still in that state", async () => {
    // a rule whose step fails, run on a real outbox event; then the state changes
    const failing = (entity: string, trigger: string) =>
      insert(
        `insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active)
         values ($1, $2, $3, $4, $5, true) returning id`,
        [org, `נכשל ${++n}`, entity, trigger, JSON.stringify([{ type: "add_tag", tag_id: "00000000-0000-4000-8000-0000000000bb" }])],
      );
    const runOn = async (auto: string, record: string, eventType: string, key: string, id: string) => {
      const event = await asAdmin(async (q) =>
        (await one<{ id: string }>(q, "select id::text from public.outbox_events where event_type = $1 and payload ->> $2 = $3 and entity_id = $4", [eventType, key, id, record])).id,
      );
      await asAdmin((q) => q("select app.execute_automation(a, $2, $3) from public.automations a where a.id = $1", [auto, record, `event:${event}`]));
      return asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.automation_runs where automation_id = $1 and run_key = $2", [auto, `event:${event}`])).id);
    };
    const retry = async (run: string) => {
      await asAdmin((q) => q("update public.automation_runs set next_retry_at = now() - interval '1 second' where id = $1", [run]));
      await asAdmin((q) => q("select app.retry_automation_runs(500)"));
      return asAdmin((q) => one<{ retry_count: number; retry_note: string | null; event_facts: unknown }>(q, "select retry_count, retry_note, event_facts from public.automation_runs where id = $1", [run]));
    };

    // quote accepted: holds while accepted; an accepted quote cancelled by an owner ends it
    const qa = await failing("contact", "quote_accepted");
    const held = await sentQuote();
    await serverStatus(held.quote, "accepted");
    const r1 = await runOn(qa, held.contact, "quote_accepted", "quote_id", held.quote);
    expect(await retry(r1)).toMatchObject({ retry_count: 1, retry_note: null, event_facts: { quote_id: held.quote } });
    const gone = await sentQuote();
    await serverStatus(gone.quote, "accepted");
    const r2 = await runOn(qa, gone.contact, "quote_accepted", "quote_id", gone.quote);
    await own((q) => q("select public.quote_cancel_accepted($1, $2, 'הלקוח חזר בו')", [org, gone.quote]));
    expect(await retry(r2)).toMatchObject({ retry_count: 0, retry_note: "event_changed" });

    // quote viewed: holds while viewed; accepted afterwards ends it
    const qv = await failing("deal", "quote_viewed");
    const v = await sentQuote();
    await serverStatus(v.quote, "viewed");
    const r3 = await runOn(qv, v.deal!, "quote_viewed", "quote_id", v.quote);
    await serverStatus(v.quote, "accepted");
    expect(await retry(r3)).toMatchObject({ retry_note: "event_changed" });

    // document: holds while active; a cancel ends it
    const dr = await failing("deal", "document_recorded");
    const deal = await newDeal(null);
    const docHolds = await insert("insert into public.accounting_documents (organization_id, deal_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', $3, 100) returning id", [org, deal, `R-${++n}`]);
    expect(await retry(await runOn(dr, deal, "document_recorded", "document_id", docHolds))).toMatchObject({ retry_count: 1, retry_note: null });
    const docGone = await insert("insert into public.accounting_documents (organization_id, deal_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', $3, 100) returning id", [org, deal, `R-${++n}`]);
    const r4 = await runOn(dr, deal, "document_recorded", "document_id", docGone);
    await own((q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [docGone]));
    expect(await retry(r4)).toMatchObject({ retry_note: "event_changed" });

    // meeting scheduled: holds while planned at the same start; moved ends it
    const ms = await failing("contact", "meeting_scheduled");
    const contact = await newContact();
    const kept = await meeting({ contact_id: contact });
    expect(await retry(await runOn(ms, contact, "meeting_scheduled", "meeting_id", kept))).toMatchObject({ retry_count: 1, retry_note: null });
    const moved = await meeting({ contact_id: contact, starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), ends_at: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString() });
    const r5 = await runOn(ms, contact, "meeting_scheduled", "meeting_id", moved);
    await own((q) => q("update public.meetings set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' where id = $1", [moved]));
    expect(await retry(r5)).toMatchObject({ retry_note: "event_changed" });

    // meeting no-show: holds while a no-show; marked held instead ends it
    const mn = await failing("contact", "meeting_no_show");
    const ns = await meeting({ contact_id: contact });
    await own((q) => q("update public.meetings set status = 'no_show' where id = $1", [ns]));
    const r6 = await runOn(mn, contact, "meeting_no_show", "meeting_id", ns);
    await own((q) => q("update public.meetings set status = 'held' where id = $1", [ns]));
    expect(await retry(r6)).toMatchObject({ retry_note: "event_changed" });

    // the business loses the quotes flag: a failed quote rule's retries end with feature_off (review low 1)
    const lost = await sentQuote();
    await serverStatus(lost.quote, "accepted");
    const r7 = await runOn(qa, lost.contact, "quote_accepted", "quote_id", lost.quote);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: false, documents: true, payments: true })]));
    try {
      expect(await retry(r7)).toMatchObject({ retry_count: 0, retry_note: "feature_off" });
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: true, documents: true, payments: true })]));
    }
    for (const id of [qa, qv, dr, ms, mn]) await asAdmin((q) => q("update public.automations set is_active = false where id = $1", [id]));
  });

  it("the event functions are triggers only: no role may run them", async () => {
    for (const fn of ["app.emit_quote_events()", "app.emit_document_recorded()", "app.emit_meeting_events()", "app.emit_commercial_event(uuid, text, jsonb, jsonb)", "app.automation_trigger_feature(text)"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const ok = await asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).ok);
        expect(ok, `${role} ${fn}`).toBe(false);
      }
    }
  });
});
