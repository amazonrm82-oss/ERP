import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * WAB-07: an exported WhatsApp chat on a record's timeline. Owner, 26 October 2026, answer (ב): history, never contact and
 * never activity, like an import note (GAP-12): stored as 'import_note' with metadata.kind 'whatsapp_import' by
 * public.whatsapp_chat_import (definer; the caller must be able to edit the record). Found by the global search.
 */
describe("imported WhatsApp chat (WAB-07)", () => {
  let owner: U, admin: U, rep: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;

  const meta = (over: Record<string, unknown> = {}) => ({
    kind: "whatsapp_import",
    via: "import",
    first_message_at: "2025-01-01T08:00:00.000Z",
    last_message_at: "2025-01-02T09:30:00.000Z",
    message_count: 3,
    kept_count: 3,
    truncated: false,
    media_count: 0,
    participants: ["דני", "נועה"],
    participant_count: 2,
    ...over,
  });
  const body = (word = "מזגן") => `שיחת WhatsApp מיובאת: 3 הודעות, 01.01.2025 עד 02.01.2025.\nמשתתפים: דני, נועה.\n\n01.01.2025 10:00 · דני: שלום, מתעניין ב${word} לסלון\n02.01.2025 11:30 · נועה: נחזור אליך`;
  const chat = (
    who: U,
    type: string,
    id: string,
    o = org,
    opts: { text?: string; at?: string; m?: Record<string, unknown> } = {},
  ) =>
    asUser(who.id, async (q) =>
      (
        await q<{ id: string }>("select public.whatsapp_chat_import($1, $2, $3, $4, $5, $6) as id", [
          o,
          type,
          id,
          opts.text ?? body(),
          opts.at ?? "2025-01-02T09:30:00.000Z",
          JSON.stringify(opts.m ?? meta()),
        ])
      ).rows[0].id,
    );
  // touch_row keeps created_at: back-dating is a test-only write with the triggers off
  const backdate = (table: string, id: string, days: number) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(`update public.${table} set created_at = now() - make_interval(days => $2) where id = $1`, [id, days]);
    });

  beforeAll(async () => {
    owner = await createUser("wa-owner");
    org = await createOrg(owner.id, "עסק השיחות");
    admin = await addMember(org, owner.id, "admin", "wa-admin");
    rep = await addMember(org, owner.id, "member", "wa-rep");
    other = await addMember(org, owner.id, "member", "wa-other");
    viewer = await addMember(org, owner.id, "viewer", "wa-viewer");
    outsider = await createUser("wa-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  it("stores one import_note by the caller, with the metadata rebuilt, on a lead, a contact and a deal", async () => {
    const lead = await insertLead(rep.id, org, { full_name: "דני", owner_id: rep.id });
    const id = await chat(rep, "lead", lead);
    const row = await asAdmin(
      async (q) =>
        (await q<{ type: string; created_by: string; lead_id: string; metadata: Record<string, unknown>; at: string }>(
          "select type, created_by, lead_id, metadata, occurred_at = '2025-01-02T09:30:00Z' as at from public.activities where id = $1",
          [id],
        )).rows[0],
    );
    expect(row).toMatchObject({ type: "import_note", created_by: rep.id, lead_id: lead, at: true });
    expect(row.metadata).toMatchObject({ kind: "whatsapp_import", via: "import", message_count: 3, participants: ["דני", "נועה"] });
    expect(row.metadata).not.toHaveProperty("import_job_id");

    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'נועה') returning id", [org])).rows[0].id,
    );
    expect(await chat(owner, "contact", contact)).toMatch(/^[0-9a-f-]{36}$/);
    const deal = await asUser(owner.id, async (q) => {
      const stage = (await q<{ id: string; pipeline_id: string }>("select id, pipeline_id from public.stages where organization_id = $1 order by position limit 1", [org])).rows[0];
      return (
        await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'מזגנים', $2, $3) returning id", [
          org,
          stage.pipeline_id,
          stage.id,
        ])
      ).rows[0].id;
    });
    expect(await chat(admin, "deal", deal)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is found by the global search, under the caller's own rights", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "חיפוש" });
    const id = await chat(owner, "lead", lead, org, { text: body("קולט-שמש-ייחודי") });
    const found = await asUser(owner.id, async (q) => (await q<{ r: { notes: { id: string }[] } }>("select public.search_records($1, $2) as r", [org, "קולט-שמש-ייחודי"])).rows[0].r);
    expect(found.notes.map((n) => n.id)).toContain(id);
    // another business's member never finds it
    const foreign = await asUser(outsider.id, async (q) => (await q<{ r: { notes: { id: string }[] } }>("select public.search_records($1, $2) as r", [org, "קולט-שמש-ייחודי"])).rows[0].r);
    expect(foreign.notes).toEqual([]);
  });

  it("is never contact: a new form lead keeps its contact times, response time and activation", async () => {
    const fresh = await createUser("wa-fresh");
    const freshOrg = await createOrg(fresh.id, "עסק חדש לשיחות");
    const token = await asUser(fresh.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id) values ($1, 'webhook', 'אתר', $2) returning token", [freshOrg, fresh.id])).rows[0].token,
    );
    const lead = await asService(
      async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [token, JSON.stringify({ full_name: "פונה", phone: "0501234567" })])).rows[0].r.lead_id,
    );
    const report = () =>
      asUser(fresh.id, async (q) =>
        (await q<{ r: { contacted: number }[] }>("select public.report_response_time($1, now() - interval '1 day', now() + interval '1 day') as r", [freshOrg])).rows[0].r,
      );
    const before = await report();
    // a chat whose last message is now: if it counted, the lead would be answered at once
    const now = await asAdmin(async (q) => (await q<{ t: string }>("select (now() - interval '1 second')::text as t")).rows[0].t);
    await chat(fresh, "lead", lead, freshOrg, { at: now, m: meta({ first_message_at: now, last_message_at: now }) });
    const row = await asAdmin(async (q) => (await q("select last_contacted_at, first_contacted_at from public.leads where id = $1", [lead])).rows[0]);
    expect(row).toEqual({ last_contacted_at: null, first_contacted_at: null });
    expect(await asAdmin((q) => count(q, "select 1 from app.org_activation where organization_id = $1", [freshOrg]))).toBe(0);
    expect(await report()).toEqual(before);
    expect((await report()).reduce((sum, r) => sum + Number(r.contacted), 0)).toBe(0);
    // the waiting-leads rule still counts it as waiting
    const waiting = await asUser(fresh.id, async (q) => (await q<{ r: { leads: { id: string }[] } }>("select public.report_money_waiting($1) as r", [freshOrg])).rows[0].r);
    expect(waiting.leads.map((l) => l.id)).toContain(lead);
  });

  it("is never activity for the 'no activity' automation and its retry facts", async () => {
    const quiet = await insertLead(owner.id, org, { full_name: "שקט" });
    await backdate("leads", quiet, 10);
    const rule = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'שקט אחרי שיחה', 'lead', 'no_activity', '{"days": 3}', '[]', '[{"type": "create_note", "body": "עדיין אין פעילות"}]', false)
           returning id`,
          [org],
        )
      ).rows[0].id,
    );
    const facts = () =>
      asAdmin(async (q) => (await q<{ f: unknown }>("select app.automation_run_facts('no_activity', '{\"days\": 3}', 'lead', $1, $2, 'noact:wa') as f", [org, quiet])).rows[0].f);
    const before = await facts();
    const now = await asAdmin(async (q) => (await q<{ t: string }>("select (now() - interval '1 second')::text as t")).rows[0].t);
    await chat(owner, "lead", quiet, org, { at: now, m: meta({ first_message_at: now, last_message_at: now }) });
    expect(await facts()).toEqual(before);
    await asAdmin(async (q) => {
      await q("delete from app.automation_scan_cursors where automation_id = $1", [rule]);
      await q("select app.scheduled_no_activity(a) from public.automations a where a.id = $1", [rule]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1 and entity_id = $2", [rule, quiet]))).toBe(1);
  });

  it("only someone who may edit the record writes one; nobody else learns whether it exists", async () => {
    const lead = await insertLead(rep.id, org, { full_name: "של הנציג", owner_id: rep.id });
    // another member reads it (visibility 'org') but may not edit it
    expect(await asUser(other.id, (q) => count(q, "select 1 from public.leads where id = $1", [lead]))).toBe(1);
    expect((await pgError(chat(other, "lead", lead))).code).toBe("42501");
    expect((await pgError(chat(viewer, "lead", lead))).code).toBe("42501");
    // an outsider: through its own business, and naming the victim's business
    expect((await pgError(chat(outsider, "lead", lead, otherOrg))).code).toBe("42501");
    expect((await pgError(chat(outsider, "lead", lead, org))).code).toBe("42501");
    // anon has no execute
    expect(
      (
        await pgError(
          asAnon((q) => q("select public.whatsapp_chat_import($1, 'lead', $2, 'x', now(), '{}')", [org, lead])),
        )
      ).code,
    ).toBe("42501");
    // a company is not offered; a record in the bin is refused
    expect((await pgError(chat(owner, "company", lead))).code).toBe("42501");
    const binned = await insertLead(owner.id, org, { full_name: "בסל" });
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [binned]));
    expect((await pgError(chat(owner, "lead", binned))).code).toBe("42501");
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1", [lead]))).toBe(0);
    // a person still cannot write an import_note directly
    expect(
      (await pgError(asUser(rep.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'import_note', 'x', $2)", [org, lead])))).code,
    ).toBe("42501");
  });

  it("checks the text, the time and the metadata", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "בדיקות" });
    const hint = async (opts: { text?: string; at?: string; m?: Record<string, unknown> }) => (await pgError(chat(owner, "lead", lead, org, opts))).hint;
    expect(await hint({ text: "  " })).toBe("whatsapp_import:body");
    expect(await hint({ text: "x".repeat(10_001) })).toBe("whatsapp_import:body");
    expect(await hint({ text: `שלום @[דני](user:${rep.id})` })).toBe("whatsapp_import:mention");
    expect(await hint({ at: "2999-01-01T00:00:00Z" })).toBe("whatsapp_import:occurred_at");
    const ahead = (seconds: number) => asAdmin(async (q) => (await q<{ t: string }>("select (now() + make_interval(secs => $1))::text as t", [seconds])).rows[0].t);
    expect(await hint({ at: await ahead(120) })).toBe("whatsapp_import:occurred_at");
    expect(await hint({ at: "1989-12-31T00:00:00Z" })).toBe("whatsapp_import:occurred_at");
    expect(await hint({ m: { ...meta(), phone: "+972501234567" } })).toBe("whatsapp_import:meta");
    expect(await hint({ m: meta({ kind: "import_note" }) })).toBe("whatsapp_import:meta");
    expect(await hint({ m: meta({ message_count: "3" }) })).toBe("whatsapp_import:meta");
    expect(await hint({ m: meta({ kept_count: 4 }) })).toBe("whatsapp_import:meta");
    expect(await hint({ m: meta({ participants: Array.from({ length: 21 }, (_, i) => `p${i}`), participant_count: 21 }) })).toBe("whatsapp_import:meta");
    expect(await hint({ m: meta({ participants: [{ name: "x" }] }) })).toBe("whatsapp_import:meta");
    expect(await hint({ m: meta({ first_message_at: "not a time" }) })).toBe("whatsapp_import:meta");
    expect(await hint({ m: meta({ last_message_at: "2025-02-01T00:00:00Z" }) })).toBe("whatsapp_import:meta");
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1", [lead]))).toBe(0);
  });

  it("allows a minute of clock skew, and never dates the entry after now", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "שעון" });
    const soon = await asAdmin(async (q) => (await q<{ t: string }>("select (now() + interval '30 seconds')::text as t")).rows[0].t);
    const id = await chat(owner, "lead", lead, org, { at: soon, m: meta({ first_message_at: soon, last_message_at: soon }) });
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where id = $1 and occurred_at <= now()", [id]))).toBe(1);
  });

  it("a wrong one is removed by an owner or admin, not by its author (GAP-12's rule for import notes)", async () => {
    const lead = await insertLead(rep.id, org, { full_name: "להסרה", owner_id: rep.id });
    const id = await chat(rep, "lead", lead);
    const removed = (who: U) => asUser(who.id, async (q) => (await q("delete from public.activities where id = $1 returning id", [id])).rowCount);
    expect(await removed(rep)).toBe(0);
    expect(await removed(admin)).toBe(1);
  });

  it("counts as work on an imported record: a member's own undo keeps the record", async () => {
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, rep.id, ["import"]]));
    const job = await asUser(rep.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows) values ($1, 'lead', 'x.csv', 'skip', 2) returning id",
          [org],
        )
      ).rows[0].id,
    );
    const a = await insertLead(rep.id, org, { full_name: "א", import_job_id: job, owner_id: rep.id });
    const b = await insertLead(rep.id, org, { full_name: "ב", import_job_id: job, owner_id: rep.id });
    await asUser(rep.id, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
    await chat(rep, "lead", b);
    const result = await asUser(rep.id, async (q) => (await q<{ r: { done: number; kept: number } }>("select public.undo_own_import($1, $2) as r", [org, job])).rows[0].r);
    expect(result).toMatchObject({ done: 1, kept: 1 });
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1 and deleted_at is null", [b]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1 and deleted_at is not null", [a]))).toBe(1);
  });
});
