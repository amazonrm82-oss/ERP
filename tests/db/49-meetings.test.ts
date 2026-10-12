import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

/** CAL-01: meetings as their own records, with team participants. */
describe("meetings", () => {
  let owner: { id: string };
  let rep: { id: string };
  let other: { id: string };
  let org: string;
  let lead: string;

  const insertSql =
    "insert into public.meetings (organization_id, title, starts_at, ends_at, meeting_type, status, video_url, lead_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id";
  const start = "2026-11-01T21:30:00Z"; // 23:30 in Israel, winter time
  const end = "2026-11-01T22:30:00Z";

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "rep");
    other = await addMember(org, owner.id, "member", "other");
    lead = await insertLead(rep.id, org, { full_name: "ליד לפגישה" });
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
  });

  it("keeps the shape of a meeting in check", async () => {
    const bad: [string, unknown[]][] = [
      ["end before start", [org, "x", end, start, "in_person", "planned", null, null]],
      ["no title", [org, "  ", start, end, "in_person", "planned", null, null]],
      ["unknown type", [org, "x", start, end, "zoom", "planned", null, null]],
      ["unknown status", [org, "x", start, end, "video", "done", null, null]],
      ["not a link", [org, "x", start, end, "video", "planned", "javascript:alert(1)", null]],
    ];
    for (const [what, params] of bad) {
      const err = await pgError(asUser(rep.id, (q) => q(insertSql, params)));
      expect(err.code, what).toBe("23514");
    }
  });

  it("stamps the organizer and creator from the session, and writes the audit log", async () => {
    const id = await asUser(rep.id, async (q) =>
      (await q<{ id: string }>(insertSql, [org, "פגישת היכרות", start, end, "video", "planned", "https://meet.example.test/abc", lead])).rows[0].id,
    );
    const row = await asAdmin(async (q) =>
      (await q<{ owner_id: string; created_by: string }>("select owner_id, created_by from public.meetings where id = $1", [id])).rows[0],
    );
    expect(row).toEqual({ owner_id: rep.id, created_by: rep.id });
    await asUser(rep.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, id, rep.id]));
    expect(
      await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type in ('meetings', 'meeting_participants')", [org])),
    ).toBe(2);
  });

  it("links only to records the writer can see, link by link", async () => {
    // other cannot see rep's lead (visibility 'own')
    const onHidden = await pgError(asUser(other.id, (q) => q(insertSql, [org, "x", start, end, "phone", "planned", null, lead])));
    expect(onHidden.code).toBe("42501");

    // a readable lead does not carry a hidden contact along
    const hiddenContact = await asUser(rep.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id,
    );
    const ownLead = await insertLead(other.id, org, { full_name: "ליד של other" });
    const mixed = await pgError(
      asUser(other.id, (q) =>
        q("insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id, contact_id) values ($1, 'x', $2, $3, $4, $5)", [org, start, end, ownLead, hiddenContact]),
      ),
    );
    expect(mixed.code).toBe("42501");

    // a participant records the outcome of a meeting on a record they cannot see, but cannot relink it
    const id = await asUser(rep.id, async (q) => (await q<{ id: string }>(insertSql, [org, "פגישה", start, end, "in_person", "planned", null, lead])).rows[0].id);
    await asUser(rep.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, id, other.id]));
    await asUser(other.id, async (q) => {
      expect((await q("update public.meetings set status = 'no_show' where id = $1", [id])).rowCount).toBe(1);
    });
    const relink = await pgError(asUser(other.id, (q) => q("update public.meetings set contact_id = $1 where id = $2", [hiddenContact, id])));
    expect(relink.code).toBe("42501");
  });

  it("purging the linked record keeps the meeting, without the link", async () => {
    const doomed = await insertLead(rep.id, org, { full_name: "ליד למחיקה" });
    const id = await asUser(rep.id, async (q) => (await q<{ id: string }>(insertSql, [org, "פגישה", start, end, "in_person", "planned", null, doomed])).rows[0].id);
    await asUser(owner.id, async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [doomed]);
      expect((await q("delete from public.leads where id = $1", [doomed])).rowCount).toBe(1);
    });
    const row = await asAdmin(async (q) => (await q<{ lead_id: string | null }>("select lead_id from public.meetings where id = $1", [id])).rows[0]);
    expect(row).toEqual({ lead_id: null });
    // the organizer still sees it
    expect(await asUser(rep.id, (q) => count(q, "select 1 from public.meetings where id = $1", [id]))).toBe(1);
  });

  it("participants are members of the organization", async () => {
    const stranger = await createUser("stranger");
    const id = await asUser(rep.id, async (q) => (await q<{ id: string }>(insertSql, [org, "פגישה", start, end, "in_person", "planned", null, null])).rows[0].id);
    const err = await pgError(
      asUser(rep.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, id, stranger.id])),
    );
    expect(err.code).toBe("23503");
  });
  it("merging records moves their meetings to the record that is kept", async () => {
    const [keep, dup] = await asUser(owner.id, async (q) => {
      const ids: string[] = [];
      for (const name of ["דנה כהן", "דנה כהן (כפול)"]) {
        ids.push((await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [org, name])).rows[0].id);
      }
      return ids;
    });
    const meeting = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id) values ($1, 'פגישה', $2, $3, $4) returning id", [org, start, end, dup])).rows[0].id,
    );
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
    const row = await asAdmin(async (q) => (await q<{ contact_id: string }>("select contact_id from public.meetings where id = $1", [meeting])).rows[0]);
    expect(row).toEqual({ contact_id: keep });

    // leads too
    const leadKeep = await insertLead(rep.id, org, { full_name: "ליד א" });
    const leadDup = await insertLead(rep.id, org, { full_name: "ליד א כפול" });
    const onLead = await asUser(rep.id, async (q) => (await q<{ id: string }>(insertSql, [org, "פגישה", start, end, "phone", "planned", null, leadDup])).rows[0].id);
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, leadKeep, leadDup]));
    const leadRow = await asAdmin(async (q) => (await q<{ lead_id: string }>("select lead_id from public.meetings where id = $1", [onLead])).rows[0]);
    expect(leadRow).toEqual({ lead_id: leadKeep });
  });

  it("a meeting on a deal needs only the deal, even when its contact is hidden from the user", async () => {
    const pipe = await defaultPipeline(org);
    const hiddenContact = await asUser(rep.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'לקוח של rep') returning id", [org])).rows[0].id,
    );
    const deal = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה של other', $2, $3, $4, $5) returning id",
          [org, pipe.pipelineId, pipe.stages[0].id, hiddenContact, other.id],
        )
      ).rows[0].id,
    );
    await asUser(other.id, async (q) => {
      expect(await count(q, "select 1 from public.contacts where id = $1", [hiddenContact])).toBe(0);
      const res = await q("insert into public.meetings (organization_id, title, starts_at, ends_at, deal_id) values ($1, 'פגישה על העסקה', $2, $3, $4) returning id", [org, start, end, deal]);
      expect(res.rowCount).toBe(1);
    });
    // copying the hidden contact along would have been refused
    const withContact = await pgError(
      asUser(other.id, (q) =>
        q("insert into public.meetings (organization_id, title, starts_at, ends_at, deal_id, contact_id) values ($1, 'x', $2, $3, $4, $5)", [org, start, end, deal, hiddenContact]),
      ),
    );
    expect(withContact.code).toBe("42501");
  });

  it("the organizer is an active member of the organization", async () => {
    const leaving = await addMember(org, owner.id, "member", "leaving");
    await asUser(owner.id, (q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, leaving.id]));
    const onInsert = await pgError(
      asUser(owner.id, (q) =>
        q("insert into public.meetings (organization_id, title, starts_at, ends_at, owner_id) values ($1, 'x', $2, $3, $4)", [org, start, end, leaving.id]),
      ),
    );
    expect(onInsert.code).toBe("23503");
    const id = await asUser(rep.id, async (q) => (await q<{ id: string }>(insertSql, [org, "פגישה", start, end, "in_person", "planned", null, null])).rows[0].id);
    const onUpdate = await pgError(asUser(rep.id, (q) => q("update public.meetings set owner_id = $1 where id = $2", [leaving.id, id])));
    expect(onUpdate.code).toBe("23503");
  });

  it("handing over a leaving employee's records moves the meetings they organize, and lets them go", async () => {
    const leaving = await addMember(org, owner.id, "member", "leaver");
    const taking = await addMember(org, owner.id, "member", "taker");
    await asUser(leaving.id, (q) => q(insertSql, [org, "פגישה של העוזב", start, end, "in_person", "planned", null, null]));
    await asUser(leaving.id, (q) => q(insertSql, [org, "עוד פגישה", start, end, "phone", "cancelled", null, null]));
    const moved = await asUser(owner.id, async (q) =>
      (await q<{ r: Record<string, number> }>("select public.transfer_records($1, $2, $3) as r", [org, leaving.id, taking.id])).rows[0].r,
    );
    expect(moved.meetings).toBe(2);
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where organization_id = $1 and owner_id = $2", [org, leaving.id]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where organization_id = $1 and owner_id = $2", [org, taking.id]))).toBe(2);
    await asUser(leaving.id, async (q) => {
      expect((await q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, leaving.id])).rowCount).toBe(1);
    });
  });
});
