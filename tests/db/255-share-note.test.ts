import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const MARK = "שותף מהטלפון";

/**
 * WAB-06, owner's answer of 27 October 2026 (ב): what the share flow saves is a 'share_note' ("הערת שיתוף") by the person,
 * first line "שותף מהטלפון". A person's note on the timeline, but neither contact (a shared lead still waits) nor activity
 * (lead's decision: like an import note). Written by anyone who may write an ordinary note on the record (owner, 28 October
 * 2026: a writer who reads it).
 */
describe("share note (WAB-06)", () => {
  let owner: U, rep: U, other: U, manager: U, viewer: U, outsider: U;
  let org: string;

  const share = (who: U, column: "lead_id" | "contact_id" | "company_id" | "deal_id", id: string, body = `${MARK}\nלקוח מהוואטסאפ`, o = org) =>
    asUser(who.id, async (q) =>
      (await q<{ id: string }>(`insert into public.activities (organization_id, type, body, ${column}) values ($1, 'share_note', $2, $3) returning id`, [o, body, id])).rows[0].id,
    );
  const changed = (who: U, sql: string, params: unknown[]) => asUser(who.id, async (q) => (await q(sql, params)).rowCount ?? 0);
  const backdate = (table: string, id: string, days: number) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(`update public.${table} set created_at = now() - make_interval(days => $2) where id = $1`, [id, days]);
    });

  beforeAll(async () => {
    owner = await createUser("share-owner");
    org = await createOrg(owner.id, "עסק השיתופים");
    rep = await addMember(org, owner.id, "member", "share-rep");
    other = await addMember(org, owner.id, "member", "share-other");
    manager = await addMember(org, owner.id, "manager", "share-manager");
    viewer = await addMember(org, owner.id, "viewer", "share-viewer");
    outsider = await createUser("share-outsider");
    await createOrg(outsider.id, "עסק זר");
  });

  it("is written by the person, with the mark, on a lead, a contact, a company and a deal", async () => {
    const lead = await insertLead(rep.id, org, { full_name: "דנה", owner_id: rep.id });
    const id = await share(rep, "lead_id", lead);
    const row = await asAdmin(async (q) => (await q("select type, created_by, body from public.activities where id = $1", [id])).rows[0]);
    expect(row).toEqual({ type: "share_note", created_by: rep.id, body: `${MARK}\nלקוח מהוואטסאפ` });
    // an image alone: the mark alone
    expect(await share(rep, "lead_id", lead, MARK)).toMatch(/^[0-9a-f-]{36}$/);

    const contact = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'רות') returning id", [org])).rows[0].id);
    const company = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'שיתופים בע\"מ') returning id", [org])).rows[0].id);
    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'מזגן', $2, $3) returning id", [org, pipelineId, stages.find((s) => s.kind === "open")!.id])).rows[0].id,
    );
    for (const [column, id2] of [["contact_id", contact], ["company_id", company], ["deal_id", deal]] as const) {
      expect(await share(owner, column, id2)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("needs the mark as its first line and an author", async () => {
    const lead = await insertLead(rep.id, org, { owner_id: rep.id });
    expect((await pgError(share(rep, "lead_id", lead, "סתם הערה"))).hint).toBe("share_note:mark");
    expect((await pgError(share(rep, "lead_id", lead, `שלום\n${MARK}`))).hint).toBe("share_note:mark");
    expect((await pgError(share(rep, "lead_id", lead, ` ${MARK}`))).hint).toBe("share_note:mark");
    // a server write with no author is refused too
    expect(
      (await pgError(asAdmin((q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'share_note', $2, $3)", [org, MARK, lead])))).hint,
    ).toBe("share_note:mark");
    // never private, never a type of the business's list
    expect(
      (await pgError(asUser(rep.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, 'share_note', $2, $3, true)", [org, MARK, lead])))).code,
    ).toBe("23514");
    const noteType = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.activity_types where organization_id = $1 and key = 'note'", [org])).rows[0].id);
    expect(
      (
        await pgError(
          asUser(rep.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id, activity_type_id) values ($1, 'share_note', $2, $3, $4)", [org, MARK, lead, noteType])),
        )
      ).hint,
    ).toBe("activity_type:invalid");
  });

  it("anyone who may write an ordinary note there writes one: a writer who reads every record of the entry (owner, 28 October 2026)", async () => {
    const note = (who: U, column: "lead_id" | "contact_id", id: string, body = "הערה") =>
      asUser(who.id, (q) => q(`insert into public.activities (organization_id, type, body, ${column}) values ($1, 'note', $2, $3)`, [org, body, id]));
    const lead = await insertLead(rep.id, org, { full_name: "של הנציג", owner_id: rep.id });
    // another member reads it but may not edit it: an ordinary note and a share note both pass
    expect(await asUser(other.id, (q) => count(q, "select 1 from public.leads where id = $1", [lead]))).toBe(1);
    expect(await asUser(other.id, (q) => count(q, "select 1 from public.leads where id = $1 and app.can_edit_record(organization_id, owner_id, team_id)", [lead]))).toBe(0);
    await note(other, "lead_id", lead);
    expect(await share(other, "lead_id", lead)).toMatch(/^[0-9a-f-]{36}$/);
    // a manager without a team over the lead too; owners too
    expect(await share(manager, "lead_id", lead)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await share(owner, "lead_id", lead)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await asAdmin((q) => q("select created_by from public.activities where lead_id = $1 and type = 'share_note' order by created_at", [lead])).then((r) => r.rows.map((x) => x.created_by))).toEqual([
      other.id,
      manager.id,
      owner.id,
    ]);
    // a viewer reads it but writes neither
    expect(await asUser(viewer.id, (q) => count(q, "select 1 from public.leads where id = $1", [lead]))).toBe(1);
    expect((await pgError(note(viewer, "lead_id", lead))).code).toBe("42501");
    expect((await pgError(share(viewer, "lead_id", lead))).code).toBe("42501");
    // an outsider, naming this business, writes neither
    expect((await pgError(share(outsider, "lead_id", lead))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'x', $2)", [org, lead])))).code).toBe("42501");
    // a record the person cannot read: neither (the business shows each member only their own leads)
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const hidden = await insertLead(rep.id, org, { full_name: "מוסתר", owner_id: rep.id });
      expect(await asUser(other.id, (q) => count(q, "select 1 from public.leads where id = $1", [hidden]))).toBe(0);
      expect((await pgError(note(other, "lead_id", hidden))).code).toBe("42501");
      expect((await pgError(share(other, "lead_id", hidden))).code).toBe("42501");
      // two records, one of them not readable
      const mine = await insertLead(other.id, org, { owner_id: other.id });
      const hiddenContact = await asUser(rep.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'של הנציג', $2) returning id", [org, rep.id])).rows[0].id);
      expect(await asUser(other.id, (q) => count(q, "select 1 from public.contacts where id = $1", [hiddenContact]))).toBe(0);
      expect(
        (
          await pgError(
            asUser(other.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id, contact_id) values ($1, 'share_note', $2, $3, $4)", [org, MARK, mine, hiddenContact])),
          )
        ).code,
      ).toBe("42501");
      expect(await share(other, "lead_id", mine)).toMatch(/^[0-9a-f-]{36}$/);
      expect(await asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1", [hidden]))).toBe(0);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // a share note on a record in the bin follows the ordinary note: same answer for both
    const binned = await insertLead(rep.id, org, { owner_id: rep.id });
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [binned]));
    const noteAnswer = await note(owner, "lead_id", binned).then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    const shareAnswer = await share(owner, "lead_id", binned).then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    expect(shareAnswer).toBe(noteAnswer);
    // the mark is still required of a reader
    expect((await pgError(share(other, "lead_id", lead, "בלי סימון"))).hint).toBe("share_note:mark");
  });

  it("its author edits and deletes it for 24 hours like a note; others do not", async () => {
    const lead = await insertLead(rep.id, org, { owner_id: rep.id });
    const id = await share(rep, "lead_id", lead);
    const edited = await changed(rep, "update public.activities set body = 'טקסט אחר' where id = $1", [id]);
    expect(edited).toBe(1);
    expect(await changed(other, "update public.activities set body = 'x' where id = $1", [id])).toBe(0);
    expect(await changed(other, "delete from public.activities where id = $1", [id])).toBe(0);
    expect(await changed(rep, "update public.activities set is_pinned = true where id = $1", [id])).toBe(1);
    expect(await changed(rep, "delete from public.activities where id = $1", [id])).toBe(1);
    // after 24 hours only owners/admins
    const old = await share(rep, "lead_id", lead);
    await backdate("activities", old, 2);
    expect(await changed(rep, "delete from public.activities where id = $1", [old])).toBe(0);
    expect(await changed(owner, "delete from public.activities where id = $1", [old])).toBe(1);
  });

  it("is never contact: contact times, response time, activation, waiting leads and retention stay as they were", async () => {
    const fresh = await createUser("share-fresh");
    const freshOrg = await createOrg(fresh.id, "עסק חדש לשיתופים");
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
    const waiting = async () =>
      (await asUser(fresh.id, async (q) => (await q<{ r: { leads: { id: string }[] } }>("select public.report_money_waiting($1) as r", [freshOrg])).rows[0].r)).leads.map((l) => l.id);
    const before = await report();
    await share(fresh, "lead_id", lead, MARK, freshOrg);
    const row = await asAdmin(async (q) => (await q("select last_contacted_at, first_contacted_at from public.leads where id = $1", [lead])).rows[0]);
    expect(row).toEqual({ last_contacted_at: null, first_contacted_at: null });
    expect(await asAdmin((q) => count(q, "select 1 from app.org_activation where organization_id = $1", [freshOrg]))).toBe(0);
    expect(await report()).toEqual(before);
    expect(await waiting()).toContain(lead);
    const breakdown = await asUser(fresh.id, async (q) =>
      (await q<{ r: { by_source: { contacted: number }[] } }>("select public.report_response_breakdown($1, now() - interval '1 day', now() + interval '1 day') as r", [freshOrg])).rows[0].r,
    );
    expect(breakdown.by_source.reduce((sum, r) => sum + Number(r.contacted ?? 0), 0)).toBe(0);
    // an ordinary note does answer it (the rule for notes is unchanged)
    await asUser(fresh.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'עניתי', $2)", [freshOrg, lead]));
    expect(await waiting()).not.toContain(lead);
    expect(await asAdmin(async (q) => (await q("select last_contacted_at is not null as c from public.leads where id = $1", [lead])).rows[0].c)).toBe(true);
  });

  it("is not contact for retention: an old lead with only a share note since stays a candidate", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ישן" });
    await backdate("leads", lead, 400);
    const candidate = () => asAdmin((q) => count(q, "select 1 from app.lead_retention_candidates($1, now() - interval '6 months', $2) c", [org, lead]));
    expect(await candidate()).toBe(1);
    await share(owner, "lead_id", lead);
    expect(await candidate()).toBe(1);
    await asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'דיברנו', $2)", [org, lead]));
    expect(await candidate()).toBe(0);
  });

  it("is not activity for the 'no activity' automation, its retry facts and check, or a deal's last activity", async () => {
    const quiet = await insertLead(owner.id, org, { full_name: "שקט" });
    await backdate("leads", quiet, 10);
    const rule = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'שקט אחרי שיתוף', 'lead', 'no_activity', '{"days": 3}', '[]', '[{"type": "create_note", "body": "עדיין אין פעילות"}]', false)
           returning id`,
          [org],
        )
      ).rows[0].id,
    );
    const facts = () =>
      asAdmin(async (q) => (await q<{ f: unknown }>("select app.automation_run_facts('no_activity', '{\"days\": 3}', 'lead', $1, $2, 'noact:share') as f", [org, quiet])).rows[0].f);
    const before = await facts();
    await share(owner, "lead_id", quiet);
    expect(await facts()).toEqual(before);
    const holds = await asAdmin(
      async (q) =>
        (
          await q<{ h: boolean }>(
            "select app.automation_event_still_holds('no_activity', '{\"days\": 3}', 'lead', $1, $2, to_jsonb(l), $3) as h from public.leads l where l.id = $2",
            [org, quiet, JSON.stringify(before)],
          )
        ).rows[0].h,
    );
    expect(holds).toBe(true);
    await asAdmin(async (q) => {
      await q("delete from app.automation_scan_cursors where automation_id = $1", [rule]);
      await q("select app.scheduled_no_activity(a) from public.automations a where a.id = $1", [rule]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1 and entity_id = $2", [rule, quiet]))).toBe(1);

    // a deal: the stuck list / board rule and the weekly cleanup's copy
    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה תקועה', $2, $3) returning id", [org, pipelineId, stages.find((s) => s.kind === "open")!.id])).rows[0].id,
    );
    await share(owner, "deal_id", deal);
    const attention = async () =>
      (await asUser(owner.id, async (q) => (await q<{ l: string | null }>("select last_activity_at as l from app.deal_attention_rows($1, null, null, 14, array[$2::uuid])", [org, deal])).rows[0])).l;
    expect(await attention()).toBeNull();
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.deals set stage_entered_at = now() - interval '60 days' where id = $1", [deal]);
    });
    const cleanup = await asUser(owner.id, async (q) => {
      const r = (await q<{ r: { deals: Array<{ id: string; last_activity_at: string | null }> } }>("select public.report_pipeline_cleanup($1) as r", [org])).rows[0].r;
      return r.deals.find((d) => d.id === deal) ?? null;
    });
    expect(cleanup).not.toBeNull();
    expect(cleanup?.last_activity_at).toBeNull();
    await asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, deal_id) values ($1, 'note', 'הערה', $2)", [org, deal]));
    expect(await attention()).not.toBeNull();
  });

  it("is a person's note otherwise: searchable, files of its author, mentions and followers told", async () => {
    const lead = await insertLead(rep.id, org, { full_name: "חיפוש", owner_id: rep.id });
    const id = await share(rep, "lead_id", lead, `${MARK}\nמזגן-שיתוף-ייחודי`);
    const found = await asUser(other.id, async (q) => (await q<{ r: { notes: { id: string }[] } }>("select public.search_records($1, $2) as r", [org, "מזגן-שיתוף-ייחודי"])).rows[0].r);
    expect(found.notes.map((n) => n.id)).toContain(id);

    // REC-07: its author attaches a file; nobody else does
    const addFile = (who: U) =>
      asUser(who.id, (q) => q("insert into public.files (organization_id, lead_id, name, mime_type, size_bytes, activity_id) values ($1, $2, 'צילום.png', 'image/png', 1000, $3)", [org, lead, id]));
    await addFile(rep);
    expect((await pgError(addFile(owner))).hint).toBe("file:note");

    // REC-02 / REC-03: a mention tells the person mentioned; the record's owner (a built-in follower) hears of another's share note
    const before = await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type in ('mention', 'follow')", [rep.id]));
    await share(owner, "lead_id", lead, `${MARK}\nלטיפול`);
    const told = await asAdmin(async (q) => (await q<{ type: string; body: string }>("select type, body from public.notifications where user_id = $1 and type = 'follow' order by created_at desc limit 1", [rep.id])).rows[0]);
    expect(told.body).toContain("הוסיף/ה הערת שיתוף");
    await share(owner, "lead_id", lead, `${MARK}\nשימו לב @[נציג](user:${rep.id})`);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'mention'", [rep.id]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type in ('mention', 'follow')", [rep.id]))).toBe(before + 2);
  });
});
