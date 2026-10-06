import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMember,
  asAdmin,
  asUser,
  closePool,
  count,
  createOrg,
  createUser,
  defaultPipeline,
  insertLead,
  pgError,
} from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

describe("CRM behaviour", () => {
  let owner: U, member: U, other: U;
  let org: string;
  let pipelineId: string;
  let stages: { id: string; kind: string }[];

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "member");
    other = await addMember(org, owner.id, "member", "other");
    ({ pipelineId, stages } = await defaultPipeline(org));
  });

  it("normalizes Israeli phone numbers and lower-cases email", async () => {
    const cases: [string, string][] = [
      ["050-123-4567", "+972501234567"],
      ["+972 50 1234567", "+972501234567"],
      ["972501234567", "+972501234567"],
      ["03-5551234", "+97235551234"],
      ["00972-50-1234567", "+972501234567"],
    ];
    for (const [input, expected] of cases) {
      const id = await insertLead(owner.id, org, { phone: input, email: "  Dana@Example.COM " });
      const row = await asAdmin(async (q) =>
        (await q<{ phone_e164: string; email: string }>("select phone_e164, email from public.leads where id = $1", [id])).rows[0],
      );
      expect(row.phone_e164, input).toBe(expected);
      expect(row.email).toBe("dana@example.com");
    }
  });

  it("an admin deletes a team that records still point to; the records keep their owner", async () => {
    const team = await asUser(owner.id, async (q) => {
      const id = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות זמני') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [org, id, member.id]);
      return id;
    });
    const lead = await insertLead(member.id, org, { full_name: "ליד של צוות", team_id: team });

    await asUser(owner.id, async (q) => {
      expect((await q("delete from public.teams where organization_id = $1 and id = $2", [org, team])).rowCount).toBe(1);
    });
    const row = await asAdmin(async (q) =>
      (await q<{ team_id: string | null; owner_id: string }>("select team_id, owner_id from public.leads where id = $1", [lead])).rows[0],
    );
    expect(row.team_id).toBeNull();
    expect(row.owner_id).toBe(member.id);
    expect(await asAdmin((q) => count(q, "select 1 from public.team_members where team_id = $1", [team]))).toBe(0);
  });

  it("derived and audit columns cannot be forged by a client", async () => {
    const id = await insertLead(member.id, org, { phone: "050-1111111", created_by: owner.id, phone_e164: "+10000000000" });
    await asUser(member.id, (q) =>
      q("update public.leads set phone_e164 = '+19999999999', created_by = $1, created_at = '2000-01-01' where id = $2", [owner.id, id]),
    );
    const row = await asAdmin(async (q) =>
      (
        await q<{ phone_e164: string; created_by: string; updated_by: string; created_at: Date }>(
          "select phone_e164, created_by, updated_by, created_at from public.leads where id = $1",
          [id],
        )
      ).rows[0],
    );
    expect(row.phone_e164).toBe("+972501111111");
    expect(row.created_by).toBe(member.id);
    expect(row.updated_by).toBe(member.id);
    expect(row.created_at.getFullYear()).toBeGreaterThan(2020);
  });

  it("a lead needs a name, a phone or an email", async () => {
    const err = await pgError(insertLead(owner.id, org, { full_name: null }));
    expect(err.code).toBe("23514");
  });

  it("a deal follows its stage: status, probability, close date and a timeline entry", async () => {
    const won = stages.find((s) => s.kind === "won")!;
    const lost = stages.find((s) => s.kind === "lost")!;
    const dealId = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, amount_agorot, status) values ($1, 'עסקה', $2, $3, 1000000, 'won') returning id",
          [org, pipelineId, stages[0].id],
        )
      ).rows[0].id,
    );
    const read = () =>
      asAdmin(async (q) =>
        (await q("select status, probability, closed_at, lost_reason from public.deals where id = $1", [dealId])).rows[0],
      );

    // the client asked for status 'won' but the stage is open
    expect(await read()).toMatchObject({ status: "open", probability: 10, closed_at: null });

    // a client cannot flip the status without moving the stage
    await asUser(owner.id, (q) => q("update public.deals set status = 'lost' where id = $1", [dealId]));
    expect((await read()).status).toBe("open");

    await asUser(owner.id, (q) => q("update public.deals set stage_id = $1 where id = $2", [won.id, dealId]));
    const afterWin = await read();
    expect(afterWin.status).toBe("won");
    expect(afterWin.probability).toBe(100);
    expect(afterWin.closed_at).not.toBeNull();

    await asUser(owner.id, (q) => q("update public.deals set stage_id = $1, lost_reason = 'מחיר' where id = $2", [lost.id, dealId]));
    expect(await read()).toMatchObject({ status: "lost", probability: 0, lost_reason: "מחיר" });

    // back to an open stage: reopened
    await asUser(owner.id, (q) => q("update public.deals set stage_id = $1 where id = $2", [stages[1].id, dealId]));
    expect(await read()).toMatchObject({ status: "open", closed_at: null, lost_reason: null });

    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.activities where deal_id = $1 and type = 'stage_change'", [dealId])).toBe(3);
    });
  });

  it("a deal's stage must belong to the deal's pipeline", async () => {
    const otherStage = await asUser(owner.id, async (q) => {
      const p = (await q<{ id: string }>("insert into public.pipelines (organization_id, name) values ($1, 'חידושים') returning id", [org])).rows[0].id;
      return (
        await q<{ id: string }>("insert into public.stages (organization_id, pipeline_id, name) values ($1, $2, 'שלב') returning id", [org, p])
      ).rows[0].id;
    });
    const err = await pgError(
      asUser(owner.id, (q) =>
        q("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'x', $2, $3)", [org, pipelineId, otherStage]),
      ),
    );
    expect(err.code).toBe("23503");
  });

  it("convert_lead creates the contact, company and deal and carries the history", async () => {
    const leadId = await insertLead(member.id, org, {
      full_name: "דנה כהן לוי",
      phone: "052-7654321",
      email: "dana@acme.example",
      company_name: "אקמה בע\"מ",
      job_title: "מנכ\"לית",
    });
    await asUser(member.id, (q) =>
      q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'שיחה ראשונה', $2)", [org, leadId]),
    );

    const result = await asUser(member.id, async (q) =>
      (await q<{ r: { contact_id: string; company_id: string; deal_id: string } }>("select public.convert_lead($1, true, null, 250000) as r", [leadId])).rows[0].r,
    );
    expect(result.contact_id).toBeTruthy();
    expect(result.company_id).toBeTruthy();
    expect(result.deal_id).toBeTruthy();

    const state = await asAdmin(async (q) => ({
      contact: (await q("select first_name, last_name, full_name, phone_e164, email, job_title, company_id, owner_id, created_by from public.contacts where id = $1", [result.contact_id])).rows[0],
      company: (await q("select name, owner_id from public.companies where id = $1", [result.company_id])).rows[0],
      deal: (await q("select name, amount_agorot, stage_id, status, contact_id, company_id, owner_id from public.deals where id = $1", [result.deal_id])).rows[0],
      lead: (
        await q(
          `select l.converted_at, l.converted_contact_id, l.converted_deal_id, s.kind
             from public.leads l join public.lead_statuses s on s.id = l.status_id where l.id = $1`,
          [leadId],
        )
      ).rows[0],
      note: (await q("select contact_id, deal_id from public.activities where lead_id = $1 and type = 'note'", [leadId])).rows[0],
      conversions: await count(q, "select 1 from public.activities where lead_id = $1 and type = 'conversion'", [leadId]),
    }));

    expect(state.contact).toMatchObject({
      first_name: "דנה",
      last_name: "כהן לוי",
      full_name: "דנה כהן לוי",
      phone_e164: "+972527654321",
      email: "dana@acme.example",
      company_id: result.company_id,
      owner_id: member.id,
      created_by: member.id,
    });
    expect(state.company).toMatchObject({ name: 'אקמה בע"מ', owner_id: member.id });
    expect(state.deal).toMatchObject({
      name: "דנה כהן לוי",
      amount_agorot: "250000",
      stage_id: stages[0].id,
      status: "open",
      contact_id: result.contact_id,
      company_id: result.company_id,
      owner_id: member.id,
    });
    expect(state.lead.converted_at).not.toBeNull();
    expect(state.lead.kind).toBe("converted");
    expect(state.lead.converted_contact_id).toBe(result.contact_id);
    expect(state.note).toMatchObject({ contact_id: result.contact_id, deal_id: result.deal_id });
    expect(state.conversions).toBe(1);

    // twice is an error, and a second lead of the same company reuses it
    expect((await pgError(asUser(member.id, (q) => q("select public.convert_lead($1)", [leadId])))).code).toBe("P0001");
    const lead2 = await insertLead(member.id, org, { full_name: "יוסי", company_name: 'אקמה בע"מ' });
    const second = await asUser(member.id, async (q) =>
      (await q<{ r: { company_id: string; deal_id: string | null } }>("select public.convert_lead($1, false) as r", [lead2])).rows[0].r,
    );
    expect(second.company_id).toBe(result.company_id);
    expect(second.deal_id).toBeNull();
  });

  it("a member cannot convert a lead they may not edit", async () => {
    const leadId = await insertLead(member.id, org);
    expect((await pgError(asUser(other.id, (q) => q("select public.convert_lead($1)", [leadId])))).code).toBe("P0002");
  });

  it("changes are written to the audit log with old and new values", async () => {
    const leadId = await insertLead(owner.id, org, { full_name: "לפני" });
    await asUser(owner.id, (q) => q("update public.leads set full_name = 'אחרי' where id = $1", [leadId]));
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [leadId]));

    const rows = await asUser(owner.id, async (q) =>
      (
        await q<{ action: string; actor_id: string; changes: Record<string, { old: unknown; new: unknown }> }>(
          "select action, actor_id, changes from public.audit_log where entity_type = 'leads' and entity_id = $1 order by id",
          [leadId],
        )
      ).rows,
    );
    expect(rows.map((r) => r.action)).toEqual(["insert", "update", "trash"]);
    expect(rows[1].actor_id).toBe(owner.id);
    expect(rows[1].changes.full_name).toEqual({ old: "לפני", new: "אחרי" });
    expect(Object.keys(rows[1].changes)).toEqual(["full_name"]);

    // the log itself cannot be edited or erased from a client
    for (const sql of ["update public.audit_log set action = 'x'", "delete from public.audit_log"]) {
      expect((await pgError(asUser(owner.id, (q) => q(sql)))).code).toBe("42501");
    }
  });

  it("every change lands in the outbox, which clients cannot read", async () => {
    const leadId = await insertLead(owner.id, org);
    await asUser(owner.id, (q) => q("update public.leads set campaign = 'קיץ' where id = $1", [leadId]));
    const events = await asAdmin(async (q) =>
      (
        await q<{ event_type: string; payload: { changed?: string[] } }>(
          "select event_type, payload from public.outbox_events where entity_id = $1 order by id",
          [leadId],
        )
      ).rows,
    );
    expect(events.map((e) => e.event_type)).toEqual(["lead.created", "lead.updated"]);
    expect(events[1].payload.changed).toEqual(["campaign"]);
    expect((await pgError(asUser(owner.id, (q) => q("select * from public.outbox_events")))).code).toBe("42501");
  });

  it("being assigned a record notifies the assignee, and only them", async () => {
    const leadId = await insertLead(owner.id, org, { owner_id: member.id, full_name: "ליד שהוקצה" });
    await asUser(member.id, async (q) => {
      const rows = (await q("select type, entity_type, entity_id, read_at from public.notifications where entity_id = $1", [leadId])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: "assigned", entity_type: "lead", read_at: null });
      expect((await q("update public.notifications set read_at = now() where entity_id = $1", [leadId])).rowCount).toBe(1);
    });
    for (const u of [owner, other]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.notifications where entity_id = $1", [leadId])).toBe(0);
      });
    }
    // creating something for yourself is not news
    const own = await insertLead(member.id, org);
    await asUser(member.id, async (q) => {
      expect(await count(q, "select 1 from public.notifications where entity_id = $1", [own])).toBe(0);
    });
    const forge = await pgError(
      asUser(member.id, (q) => q("update public.notifications set title = 'x' where entity_id = $1", [leadId])),
    );
    expect(forge.code).toBe("42501");
  });

  it("tasks: the assignee and the creator both see a task; completing stamps the time", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    const taskId = await asUser(member.id, async (q) =>
      (
        await q<{ id: string }>("insert into public.tasks (organization_id, title, owner_id) values ($1, 'להתקשר', $2) returning id", [org, other.id])
      ).rows[0].id,
    );
    const visible = (u: U) => asUser(u.id, (q) => count(q, "select 1 from public.tasks where id = $1", [taskId]));
    expect(await visible(member)).toBe(1); // creator
    expect(await visible(other)).toBe(1); // assignee
    expect(await visible(owner)).toBe(1); // admin
    const third = await addMember(org, owner.id, "member", "third");
    expect(await visible(third)).toBe(0);

    await asUser(other.id, (q) => q("update public.tasks set status = 'done' where id = $1", [taskId]));
    const done = await asAdmin(async (q) => (await q("select status, completed_at from public.tasks where id = $1", [taskId])).rows[0]);
    expect(done.status).toBe("done");
    expect(done.completed_at).not.toBeNull();
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
  });

  it("a note belongs to its author: others cannot edit or delete it", async () => {
    const leadId = await insertLead(member.id, org);
    const noteId = await asUser(member.id, async (q) =>
      (
        await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'שלי', $2) returning id", [org, leadId])
      ).rows[0].id,
    );
    await asUser(other.id, async (q) => {
      expect(await count(q, "select 1 from public.activities where id = $1", [noteId])).toBe(1);
      expect((await q("update public.activities set body = 'נערך' where id = $1", [noteId])).rowCount).toBe(0);
      expect((await q("delete from public.activities where id = $1", [noteId])).rowCount).toBe(0);
    });
    await asUser(member.id, async (q) => {
      expect((await q("update public.activities set body = 'עודכן' where id = $1", [noteId])).rowCount).toBe(1);
    });
    const relink = await pgError(
      asUser(member.id, (q) => q("update public.activities set created_by = $1 where id = $2", [other.id, noteId])),
    );
    expect(relink.code).toBe("42501");
  });

  it("profiles: colleagues see each other, strangers do not, nobody edits someone else", async () => {
    const stranger = await createUser("stranger");
    await asUser(member.id, async (q) => {
      expect(await count(q, "select 1 from public.profiles where id = $1", [owner.id])).toBe(1);
      expect(await count(q, "select 1 from public.profiles where id = $1", [stranger.id])).toBe(0);
      expect((await q("update public.profiles set full_name = 'x' where id = $1", [owner.id])).rowCount).toBe(0);
      expect((await q("update public.profiles set full_name = 'חבר צוות' where id = $1", [member.id])).rowCount).toBe(1);
    });
  });
});
