import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultLeadStatus, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const FILTER = { match: "all", groups: [{ match: "all", conditions: [{ field: "status", op: "is", value: "x" }] }] };

/**
 * SEG-01: segments of leads or contacts. A dynamic one keeps the list filter; a static one has members. Every member
 * reads them; owners, admins and managers of a writable business write them. A member row is seen only with its record.
 */
describe("segments (SEG-01)", () => {
  let owner: U, admin: U, manager: U, member: U, member2: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let leadOwn: string, leadOther: string;

  const newSegment = (who: U, fields: Record<string, unknown> = {}, o: string = org) =>
    asUser(who.id, async (q) => {
      const row: Record<string, unknown> = { organization_id: o, object_type: "lead", kind: "static", name: "לקוחות חמים", ...fields };
      const cols = Object.keys(row);
      return (
        await q<{ id: string }>(
          `insert into public.segments (${cols.join(", ")}) values (${cols.map((c, i) => (c === "filter" ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ")}) returning id`,
          Object.values(row).map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v)),
        )
      ).rows[0].id;
    });
  const addMemberRow = (who: U, segment: string, fields: Record<string, string>) =>
    asUser(who.id, (q) => {
      const cols = ["organization_id", "segment_id", ...Object.keys(fields)];
      return q(`insert into public.segment_members (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, [org, segment, ...Object.values(fields)]);
    });
  const setPlan = (features: Record<string, unknown>, limits: Record<string, unknown>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2, limit_overrides = $3 where organization_id = $1", [org, JSON.stringify(features), JSON.stringify(limits)]));

  beforeAll(async () => {
    owner = await createUser("seg-owner");
    org = await createOrg(owner.id, "עסק הסגמנטים");
    admin = await addMember(org, owner.id, "admin", "seg-admin");
    manager = await addMember(org, owner.id, "manager", "seg-manager");
    member = await addMember(org, owner.id, "member", "seg-member");
    member2 = await addMember(org, owner.id, "member", "seg-member2");
    viewer = await addMember(org, owner.id, "viewer", "seg-viewer");
    outsider = await createUser("seg-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    // each person sees only their own records
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    leadOwn = await insertLead(member.id, org, { full_name: "ליד שלי", owner_id: member.id });
    leadOther = await insertLead(member2.id, org, { full_name: "ליד של אחר", owner_id: member2.id });
  });

  it("owners, admins and managers write segments; members and viewers only read them", async () => {
    for (const who of [owner, admin, manager]) expect(await newSegment(who, { name: `של ${who.email.slice(0, 10)}` })).toMatch(/^[0-9a-f-]{36}$/);
    for (const who of [member, viewer]) expect((await pgError(newSegment(who))).code).toBe("42501");
    const id = await newSegment(manager, { name: "לעדכון" });
    for (const who of [member, viewer]) {
      expect(await asUser(who.id, (q) => count(q, "select 1 from public.segments where id = $1", [id]))).toBe(1);
      // a write without WHERE reaches nothing
      expect((await asUser(who.id, (q) => q("update public.segments set name = 'נחטף'"))).rowCount).toBe(0);
      expect((await asUser(who.id, (q) => q("delete from public.segments"))).rowCount).toBe(0);
    }
    expect(await asUser(manager.id, async (q) => (await q("update public.segments set name = 'עודכן' where id = $1", [id])).rowCount)).toBe(1);
    // the type and the kind are fixed
    expect((await pgError(asUser(owner.id, (q) => q("update public.segments set kind = 'dynamic' where id = $1", [id])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.segments set object_type = 'contact' where id = $1", [id])))).code).toBe("42501");
    // another business sees none of them and writes none
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.segments where organization_id = $1", [org]))).toBe(0);
    expect((await pgError(newSegment(outsider))).code).toBe("42501");
    // nor puts this business's lead into a segment of its own
    const theirs = await newSegment(outsider, { name: "שלהם" }, otherOrg);
    const crossed = await pgError(
      asUser(outsider.id, (q) => q("insert into public.segment_members (organization_id, segment_id, lead_id) values ($1, $2, $3)", [otherOrg, theirs, leadOwn])),
    );
    expect(["42501", "23503"]).toContain(crossed.code);
  });

  it("a dynamic segment keeps its filter, a static one none", async () => {
    expect(await newSegment(admin, { kind: "dynamic", name: "דינמי", filter: FILTER })).toMatch(/^[0-9a-f-]{36}$/);
    expect((await pgError(newSegment(admin, { kind: "dynamic", name: "בלי סינון" }))).code).toBe("23514");
    expect((await pgError(newSegment(admin, { kind: "static", name: "עם סינון", filter: FILTER }))).code).toBe("23514");
    expect((await pgError(newSegment(admin, { kind: "dynamic", name: "מערך", filter: [1, 2] }))).code).toBe("23514");
  });

  it("the plan: the segments flag, and max_segments for the business (null = unlimited)", async () => {
    await setPlan({ segments: false }, {});
    expect((await pgError(newSegment(owner, { name: "בלי דגל" }))).hint).toBe("feature:segments");
    const have = await asAdmin((q) => count(q, "select 1 from public.segments where organization_id = $1", [org]));
    await setPlan({ segments: true }, { max_segments: have });
    expect((await pgError(newSegment(owner, { name: "מעל המכסה" }))).hint).toBe("limit:max_segments");
    await setPlan({ segments: true }, { max_segments: null });
    expect(await newSegment(owner, { name: "בלי מכסה" })).toMatch(/^[0-9a-f-]{36}$/);
    // a member is refused by RLS, not told about the plan
    await setPlan({ segments: false }, {});
    expect((await pgError(newSegment(member, { name: "חבר" }))).code).toBe("42501");
    await setPlan({}, {});
  });

  it("static members: a record of the segment's type, once, only one the writer reads; seen only with the record", async () => {
    const leads = await newSegment(manager, { name: "רשימת לידים" });
    const contacts = await newSegment(manager, { name: "רשימת אנשי קשר", object_type: "contact" });
    const dynamic = await newSegment(manager, { name: "דינמי 2", kind: "dynamic", filter: FILTER });
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'איש') returning id", [org])).rows[0].id,
    );
    await addMemberRow(owner, leads, { lead_id: leadOwn });
    await addMemberRow(owner, leads, { lead_id: leadOther });
    expect((await pgError(addMemberRow(owner, leads, { lead_id: leadOwn }))).code).toBe("23505");
    expect((await pgError(addMemberRow(owner, leads, { contact_id: contact }))).hint).toBe("segment_member:invalid");
    expect((await pgError(addMemberRow(owner, contacts, { lead_id: leadOwn }))).hint).toBe("segment_member:invalid");
    expect((await pgError(addMemberRow(owner, dynamic, { lead_id: leadOwn }))).hint).toBe("segment_member:invalid");
    expect((await pgError(addMemberRow(owner, leads, { lead_id: leadOwn, contact_id: contact }))).code).toBe("23514");
    await addMemberRow(owner, contacts, { contact_id: contact });
    // each person sees the members whose record they read
    const seen = (who: U) => asUser(who.id, (q) => count(q, "select 1 from public.segment_members where segment_id = $1", [leads]));
    expect(await seen(owner)).toBe(2);
    expect(await seen(member)).toBe(1);
    expect(await seen(member2)).toBe(1);
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.segment_members where organization_id = $1", [org]))).toBe(0);
    // the same for contacts: the owner's contact is hidden from a member, the member's own is not
    const memberContact = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'של החבר', $2) returning id", [org, member.id])).rows[0].id,
    );
    await addMemberRow(owner, contacts, { contact_id: memberContact });
    const seenContacts = (who: U) => asUser(who.id, (q) => count(q, "select 1 from public.segment_members where segment_id = $1", [contacts]));
    expect(await seenContacts(owner)).toBe(2);
    expect(await seenContacts(member)).toBe(1);
    expect(await seenContacts(member2)).toBe(0);
    // a writer adds only a record they read; members and viewers never add or remove
    const team = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות') returning id", [org])).rows[0].id);
    await asAdmin((q) => q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [org, team, manager.id]));
    const notManaged = await insertLead(member2.id, org, { full_name: "לא בצוות", owner_id: member2.id });
    expect((await pgError(addMemberRow(manager, leads, { lead_id: notManaged }))).code).toBe("42501");
    expect((await pgError(addMemberRow(member, leads, { lead_id: leadOwn }))).code).toBe("42501");
    expect((await asUser(member.id, (q) => q("delete from public.segment_members"))).rowCount).toBe(0);
    expect((await asUser(viewer.id, (q) => q("delete from public.segment_members"))).rowCount).toBe(0);
    // no update at all
    expect((await pgError(asUser(owner.id, (q) => q("update public.segment_members set lead_id = $2 where segment_id = $1", [leads, notManaged])))).code).toBe("42501");
    // a writer's bare delete reaches only members whose record they read (the manager reads neither lead)
    expect((await asUser(manager.id, (q) => q("delete from public.segment_members where segment_id = $1", [leads]))).rowCount).toBe(0);
    expect((await asUser(manager.id, (q) => q("delete from public.segment_members where segment_id = $1", [contacts]))).rowCount).toBe(0);
    // a DELETE without WHERE is judged by the delete policy alone (no select policy applies to it)
    expect((await asUser(manager.id, (q) => q("delete from public.segment_members"))).rowCount).toBe(0);
    expect(await seen(owner)).toBe(2);
    // removing: the writers; the record's purge and the segment's removal take the rows with them
    expect(await asUser(owner.id, async (q) => (await q("delete from public.segment_members where segment_id = $1 and lead_id = $2", [leads, leadOther])).rowCount)).toBe(1);
    await asUser(owner.id, (q) => q("delete from public.segments where id = $1", [contacts]));
    expect(await asAdmin((q) => count(q, "select 1 from public.segment_members where segment_id = $1", [contacts]))).toBe(0);
  });

  it("a static segment holds at most 10,000 records", async () => {
    const big = await newSegment(admin, { name: "גדולה" });
    // 10,000 leads and 9,999 members, written without triggers to keep the test quick
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(
        `insert into public.leads (organization_id, full_name, owner_id, status_id)
         select $1, 'גדול-' || g, $2, $3 from generate_series(1, 10000) g`,
        [org, admin.id, await defaultLeadStatus(org)],
      );
      await q(
        `insert into public.segment_members (organization_id, segment_id, lead_id)
         select $1, $2, l.id from public.leads l
          where l.organization_id = $1 and l.full_name like 'גדול-%' and l.full_name <> 'גדול-10000'`,
        [org, big],
      );
    });
    const last = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.leads where organization_id = $1 and full_name = 'גדול-10000'", [org])).rows[0].id);
    await addMemberRow(admin, big, { lead_id: last });
    expect(await asAdmin((q) => count(q, "select 1 from public.segment_members where segment_id = $1", [big]))).toBe(10000);
    expect((await pgError(addMemberRow(admin, big, { lead_id: leadOwn }))).hint).toBe("segment_members:max");
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("delete from public.segment_members where segment_id = $1", [big]);
      await q("delete from public.leads where organization_id = $1 and full_name like 'גדול-%'", [org]);
    });
  });

  it("undoing one's own import keeps a record put in a static segment after it", async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const lead = await insertLead(owner.id, org, { full_name: "מיובא", owner_id: owner.id });
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'מיובא') returning id", [org])).rows[0].id,
    );
    const worked = (type: string, id: string) =>
      asAdmin(async (q) => (await q<{ w: boolean }>("select app.import_record_worked($1, $2, $3, $4, null) as w", [org, type, id, since])).rows[0].w);
    expect(await worked("lead", lead)).toBe(false);
    expect(await worked("contact", contact)).toBe(false);
    const leadList = await newSegment(owner, { name: "אחרי ייבוא" });
    const contactList = await newSegment(owner, { name: "אחרי ייבוא אנשי קשר", object_type: "contact" });
    await addMemberRow(owner, leadList, { lead_id: lead });
    await addMemberRow(owner, contactList, { contact_id: contact });
    expect(await worked("lead", lead)).toBe(true);
    expect(await worked("contact", contact)).toBe(true);
  });

  it("a read-only business takes no writes", async () => {
    const id = await newSegment(owner, { name: "לפני קריאה בלבד" });
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(newSegment(owner, { name: "בקריאה" }))).code).toBe("42501");
      expect((await asUser(owner.id, (q) => q("update public.segments set name = 'x'"))).rowCount).toBe(0);
      expect((await asUser(owner.id, (q) => q("delete from public.segments"))).rowCount).toBe(0);
      expect((await pgError(addMemberRow(owner, id, { lead_id: leadOwn }))).code).toBe("42501");
      expect(await asUser(member.id, (q) => count(q, "select 1 from public.segments where id = $1", [id]))).toBe(1);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("a merge carries the duplicate's memberships to the kept record", async () => {
    const keep = await insertLead(owner.id, org, { full_name: "נשאר", phone: "0501110101", owner_id: owner.id });
    const dup = await insertLead(owner.id, org, { full_name: "כפול", phone: "0501110102", owner_id: owner.id });
    const a = await newSegment(owner, { name: "מיזוג א" });
    const b = await newSegment(owner, { name: "מיזוג ב" });
    await addMemberRow(owner, a, { lead_id: dup });
    await addMemberRow(owner, b, { lead_id: dup });
    await addMemberRow(owner, b, { lead_id: keep });
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep, dup]));
    const rows = await asAdmin(
      async (q) =>
        (await q<{ segment_id: string }>("select segment_id from public.segment_members where lead_id = $1 order by segment_id", [keep])).rows.map((r) => r.segment_id),
    );
    expect(rows.sort()).toEqual([a, b].sort());
  });

  it("sample data put in a static segment is kept when the samples are removed", async () => {
    const sampleOwner = await createUser("seg-sample");
    const sampleOrg = await createOrg(sampleOwner.id);
    await asUser(sampleOwner.id, (q) => q("select public.sample_data_add($1)", [sampleOrg]));
    const lead = await asAdmin(async (q) => (await q<{ id: string }>("select lead_id as id from app.sample_records where organization_id = $1 and lead_id is not null limit 1", [sampleOrg])).rows[0].id);
    const segment = await asUser(sampleOwner.id, async (q) =>
      (await q<{ id: string }>("insert into public.segments (organization_id, object_type, kind, name) values ($1, 'lead', 'static', 'דוגמה') returning id", [sampleOrg])).rows[0].id,
    );
    await asUser(sampleOwner.id, (q) => q("insert into public.segment_members (organization_id, segment_id, lead_id) values ($1, $2, $3)", [sampleOrg, segment, lead]));
    await asUser(sampleOwner.id, (q) => q("select public.sample_data_remove($1)", [sampleOrg]));
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1", [lead]))).toBe(1);
  });
});
