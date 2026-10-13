import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// REC-03: a user follows a lead, contact, company or deal and is told (kind 'follow') when its status or
// stage changes, its owner changes, or a person logs a new entry on it. Never the one who made the change,
// only while the follower may read the record, never about a private note, never with an entry's text.
describe("followers of a record (REC-03)", () => {
  let owner: U, admin: U, actor: U, follower: U, other: U, outsider: U;
  let org: string, lead: string, contact: string, company: string, deal: string;
  let nextStatus: { id: string; name: string };
  let stages: { id: string; name: string }[];

  beforeAll(async () => {
    owner = await createUser("fl-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "fl-admin");
    actor = await addMember(org, owner.id, "member", "fl-actor");
    follower = await addMember(org, owner.id, "member", "fl-follower");
    other = await addMember(org, owner.id, "member", "fl-other");
    outsider = await createUser("fl-outsider");
    await createOrg(outsider.id, "עסק אחר");

    lead = await insertLead(actor.id, org, { full_name: "דנה כהן" });
    const pipe = await defaultPipeline(org);
    ({ contact, company, deal } = await asUser(actor.id, async (q) => {
      const companyId = (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'אלפא בע\"מ') returning id", [org])).rows[0].id;
      const contactId = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, last_name) values ($1, 'רות', 'לוי') returning id", [org])).rows[0].id;
      const dealId = (
        await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקת ענן', $2, $3) returning id", [
          org,
          pipe.pipelineId,
          pipe.stages[0].id,
        ])
      ).rows[0].id;
      return { contact: contactId, company: companyId, deal: dealId };
    }));
    nextStatus = await asAdmin(async (q) =>
      (
        await q<{ id: string; name: string }>(
          "select id, name from public.lead_statuses where organization_id = $1 and not is_default and kind = 'open' order by position limit 1",
          [org],
        )
      ).rows[0],
    );
    stages = await asAdmin(async (q) =>
      (await q<{ id: string; name: string }>("select id, name from public.stages where pipeline_id = $1 order by position", [pipe.pipelineId])).rows,
    );
  });

  const follow = (u: U, column: "lead_id" | "contact_id" | "company_id" | "deal_id", id: string) =>
    asUser(u.id, (q) => q(`insert into public.record_followers (organization_id, ${column}) values ($1, $2)`, [org, id]));
  const told = (u: U) =>
    asAdmin(async (q) =>
      (
        await q<{ title: string; body: string | null; entity_type: string; entity_id: string; organization_id: string }>(
          "select title, body, entity_type, entity_id, organization_id from public.notifications where user_id = $1 and type = 'follow' order by created_at, id",
          [u.id],
        )
      ).rows,
    );
  const since = async (u: U, fn: () => Promise<unknown>) => {
    const before = (await told(u)).length;
    await fn();
    return (await told(u)).slice(before);
  };

  it("a lead's status change tells its followers, not the one who changed it", async () => {
    await follow(follower, "lead_id", lead);
    await follow(actor, "lead_id", lead);
    const actorBefore = (await told(actor)).length;
    const got = await since(follower, () => asUser(actor.id, (q) => q("update public.leads set status_id = $2 where id = $1", [lead, nextStatus.id])));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ entity_type: "lead", entity_id: lead, organization_id: org, title: "עדכון בליד שבמעקב: דנה כהן" });
    expect(got[0].body).toBe(`fl-actor שינה/תה את הסטטוס ל: ${nextStatus.name}`);
    expect((await told(actor)).length).toBe(actorBefore);
    // nobody else hears about it, and a change of another column says nothing
    expect(await told(other)).toHaveLength(0);
    expect(await since(follower, () => asUser(actor.id, (q) => q("update public.leads set campaign = 'אביב' where id = $1", [lead])))).toHaveLength(0);
  });

  it("a deal's stage change and an owner change; the new owner hears 'assigned' instead", async () => {
    await follow(follower, "deal_id", deal);
    const moved = await since(follower, () => asUser(actor.id, (q) => q("update public.deals set stage_id = $2 where id = $1", [deal, stages[1].id])));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ entity_type: "deal", entity_id: deal, title: "עדכון בעסקה שבמעקב: עסקת ענן", body: `fl-actor העביר/ה לשלב: ${stages[1].name}` });

    await follow(other, "deal_id", deal);
    const otherBefore = (await told(other)).length;
    const handed = await since(follower, () => asUser(admin.id, (q) => q("update public.deals set owner_id = $2 where id = $1", [deal, other.id])));
    expect(handed).toHaveLength(1);
    expect(handed[0].body).toBe("fl-admin שינה/תה את האחראי ל: fl-other");
    // the new owner is told by notify_assignment, not twice
    expect((await told(other)).length).toBe(otherBefore);
    expect(
      await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'assigned' and entity_id = $2", [other.id, deal])),
    ).toBe(1);
  });

  it("contacts and companies: an owner change", async () => {
    await follow(follower, "contact_id", contact);
    await follow(follower, "company_id", company);
    const got = await since(follower, async () => {
      await asUser(admin.id, (q) => q("update public.contacts set owner_id = $2 where id = $1", [contact, admin.id]));
      await asUser(admin.id, (q) => q("update public.companies set owner_id = $2 where id = $1", [company, admin.id]));
    });
    expect(got.map((n) => [n.entity_type, n.title, n.body])).toEqual([
      ["contact", "עדכון באיש קשר שבמעקב: רות לוי", "fl-admin שינה/תה את האחראי ל: fl-admin"],
      ["company", 'עדכון בחברה שבמעקב: אלפא בע"מ', "fl-admin שינה/תה את האחראי ל: fl-admin"],
    ]);
  });

  it("a change without a person (an automation) is told without a name", async () => {
    const got = await since(follower, () => asAdmin((q) => q("update public.deals set stage_id = $2 where id = $1", [deal, stages[2].id])));
    expect(got).toHaveLength(1);
    expect(got[0].body).toBe(`השלב השתנה ל: ${stages[2].name}`);
  });

  it("a new entry tells followers who it was and what kind, never its text", async () => {
    const got = await since(follower, () =>
      asUser(actor.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'סוד מסחרי', $2)", [org, lead])),
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ entity_type: "lead", entity_id: lead, title: "עדכון בליד שבמעקב: דנה כהן", body: "fl-actor הוסיף/ה הערה" });
    expect(JSON.stringify(got)).not.toContain("סוד");

    const call = await since(follower, () =>
      asUser(actor.id, (q) => q("insert into public.activities (organization_id, type, body, deal_id) values ($1, 'call', 'שיחה', $2)", [org, deal])),
    );
    expect(call.map((n) => [n.entity_type, n.body])).toEqual([["deal", "fl-actor תיעד/ה שיחה"]]);
  });

  it("an entry on two followed records tells a follower once", async () => {
    const got = await since(follower, () =>
      asUser(actor.id, (q) =>
        q("insert into public.activities (organization_id, type, body, contact_id, deal_id) values ($1, 'note', 'x', $2, $3)", [org, contact, deal]),
      ),
    );
    expect(got.map((n) => n.entity_type)).toEqual(["contact"]);
  });

  it("a private note, an entry a server function writes, and the author's own entry tell nobody", async () => {
    const got = await since(follower, async () => {
      await asUser(actor.id, (q) =>
        q("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, 'note', 'פרטי', $2, true)", [org, lead]),
      );
      // written by the server (not the authenticated role), with an author
      await asAdmin((q) =>
        q("insert into public.activities (organization_id, type, body, lead_id, created_by) values ($1, 'note', 'שרת', $2, $3)", [org, lead, actor.id]),
      );
      await asUser(follower.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'שלי', $2)", [org, lead]));
    });
    expect(got).toHaveLength(0);
  });

  it("a follower mentioned in the entry gets the mention only", async () => {
    const before = await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'mention'", [follower.id]));
    const got = await since(follower, () =>
      asUser(actor.id, (q) =>
        q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', $2, $3)", [org, `@[עוקב](user:${follower.id}) תראה`, lead]),
      ),
    );
    expect(got).toHaveLength(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'mention'", [follower.id]))).toBe(before + 1);
  });

  it("only followers who may still read the record are told", async () => {
    // 'own': the follower no longer sees the actor's lead
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const entry = await since(follower, () =>
        asUser(actor.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'x', $2)", [org, lead])),
      );
      expect(entry).toHaveLength(0);
      const status = await since(follower, () => asUser(actor.id, (q) => q("update public.leads set status_id = (select id from public.lead_statuses where organization_id = $2 and is_default) where id = $1", [lead, org])));
      expect(status).toHaveLength(0);
      // handed to the follower: they see it again and hear 'assigned', not 'follow'
      const handed = await since(follower, () => asUser(admin.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [lead, follower.id])));
      expect(handed).toHaveLength(0);
      // and handed away from them: they no longer see it, so they are not told
      const away = await since(follower, () => asUser(admin.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [lead, actor.id])));
      expect(away).toHaveLength(0);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a handover of someone's records and a record in the recycle bin tell nobody", async () => {
    const got = await since(follower, async () => {
      await asUser(owner.id, (q) => q("select public.transfer_records($1, $2, $3)", [org, actor.id, other.id]));
      await asUser(admin.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
      await asAdmin((q) => q("update public.leads set status_id = $2 where id = $1", [lead, nextStatus.id]));
    });
    expect(got).toHaveLength(0);
  });

  it("an outsider cannot follow, and follow rows go with the record and with the membership", async () => {
    expect((await pgError(follow(outsider, "lead_id", lead))).code).toBe("42501");
    expect(await asAdmin((q) => count(q, "select 1 from public.record_followers where lead_id = $1", [lead]))).toBe(2);
    // purged from the recycle bin
    await asUser(admin.id, (q) => q("delete from public.leads where id = $1", [lead]));
    expect(await asAdmin((q) => count(q, "select 1 from public.record_followers where lead_id = $1", [lead]))).toBe(0);
    // removed from the organization
    expect(await asAdmin((q) => count(q, "select 1 from public.record_followers where user_id = $1", [follower.id]))).toBeGreaterThan(0);
    await asAdmin((q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, follower.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.record_followers where user_id = $1", [follower.id]))).toBe(0);
  });
});
