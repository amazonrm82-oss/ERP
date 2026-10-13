import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

describe("merging duplicates", () => {
  let owner: U, member: U, outsider: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("merge-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member");
    outsider = await createUser("merge-outsider");
    await createOrg(outsider.id);
  });

  const merge = (userId: string, type: string, keep: string, dup: string, picks: Record<string, string> = {}) =>
    asUser(userId, (q) => q("select public.merge_records($1, $2, $3, $4, $5)", [org, type, keep, dup, JSON.stringify(picks)]));
  const row = (table: string, id: string) => asAdmin(async (q) => (await q(`select * from public.${table} where id = $1`, [id])).rows[0]);

  it("two leads become one: picked fields, joined tags, everything moved, the duplicate gone", async () => {
    const keep = await insertLead(owner.id, org, { full_name: "דנה כהן", email: "dana@example.test" });
    const dup = await insertLead(owner.id, org, { full_name: "דנה", phone: "050-1112233", campaign: "פייסבוק" });
    const tags = await asAdmin(async (q) => {
      const a = (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'VIP') returning id", [org])).rows[0].id;
      const b = (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'חם') returning id", [org])).rows[0].id;
      await q("update public.leads set tag_ids = array[$1::uuid] where id = $2", [a, keep]);
      await q("update public.leads set tag_ids = array[$1::uuid] where id = $2", [b, dup]);
      await q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה עם הכפולה', $2)", [org, dup]);
      await q("insert into public.tasks (organization_id, title, owner_id, lead_id) values ($1, 'לחזור', $2, $3)", [org, owner.id, dup]);
      await q("insert into public.files (organization_id, lead_id, name, mime_type, size_bytes, uploaded_by) values ($1, $2, 'x.pdf', 'application/pdf', 10, $3)", [org, dup, owner.id]);
      return [a, b];
    });

    await merge(owner.id, "lead", keep, dup, { phone: "merge", campaign: "merge" });

    const kept = await row("leads", keep);
    expect(kept.full_name).toBe("דנה כהן");
    expect(kept.email).toBe("dana@example.test");
    expect(kept.phone).toBe("050-1112233");
    expect(kept.phone_e164).toBe("+972501112233");
    expect(kept.campaign).toBe("פייסבוק");
    expect([...kept.tag_ids].sort()).toEqual([...tags].sort());
    expect(await row("leads", dup)).toBeUndefined();
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1 and body = 'שיחה עם הכפולה'", [keep]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where lead_id = $1", [keep]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.files where lead_id = $1", [keep]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1 and body like 'מוזג עם רשומה כפולה%'", [keep]))).toBe(1);
  });

  it("merging contacts moves deals and keeps one participant row; companies take their contacts along", async () => {
    const ids = await asAdmin(async (q) => {
      const companyKeep = (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'אלפא') returning id", [org])).rows[0].id;
      const companyDup = (await q<{ id: string }>("insert into public.companies (organization_id, name, tax_id) values ($1, 'אלפא בע\"מ', '514111111') returning id", [org])).rows[0].id;
      const keep = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id, company_id) values ($1, 'משה', $2, $3) returning id", [org, owner.id, companyDup])).rows[0].id;
      const dup = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email, owner_id) values ($1, 'משה', 'moshe@example.test', $2) returning id", [org, owner.id])).rows[0].id;
      return { companyKeep, companyDup, keep, dup };
    });
    const pipe = await defaultPipeline(org);
    const deal = await asAdmin(async (q) => {
      const d = (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [org, pipe.pipelineId, pipe.stages[0].id, ids.dup, ids.companyDup])).rows[0].id;
      await q("insert into public.deal_contacts (organization_id, deal_id, contact_id) values ($1, $2, $3), ($1, $2, $4)", [org, d, ids.keep, ids.dup]);
      return d;
    });

    await merge(owner.id, "contact", ids.keep, ids.dup, { email: "merge" });
    expect((await row("contacts", ids.keep)).email).toBe("moshe@example.test");
    expect((await row("deals", deal)).contact_id).toBe(ids.keep);
    expect(await asAdmin((q) => count(q, "select 1 from public.deal_contacts where deal_id = $1", [deal]))).toBe(1);

    await merge(owner.id, "company", ids.companyKeep, ids.companyDup, { tax_id: "merge" });
    expect((await row("companies", ids.companyKeep)).tax_id).toBe("514111111");
    expect((await row("contacts", ids.keep)).company_id).toBe(ids.companyKeep);
    expect((await row("deals", deal)).company_id).toBe(ids.companyKeep);
  });

  it("followers move to the kept record: one row per user, none lost (REC-03 follow-up)", async () => {
    const third = await addMember(org, owner.id, "member", "merge-third");
    const follow = (user: string, col: string, id: string) =>
      asAdmin((q) => q(`insert into public.record_followers (organization_id, user_id, ${col}) values ($1, $2, $3)`, [org, user, id]));
    const followersOf = (col: string, id: string) =>
      asAdmin(async (q) =>
        (await q<{ user_id: string }>(`select user_id::text from public.record_followers where ${col} = $1 order by user_id::text collate "C"`, [id])).rows.map(
          (r) => r.user_id,
        ),
      );
    const sorted = (xs: string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // leads: owner follows both, member only the duplicate, third only the kept one
    const keep = await insertLead(owner.id, org, { full_name: "עוקבים א" });
    const dup = await insertLead(owner.id, org, { full_name: "עוקבים ב" });
    await follow(owner.id, "lead_id", keep);
    await follow(owner.id, "lead_id", dup);
    await follow(member.id, "lead_id", dup);
    await follow(third.id, "lead_id", keep);
    await merge(owner.id, "lead", keep, dup);
    expect(await followersOf("lead_id", keep)).toEqual(sorted([owner.id, member.id, third.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.record_followers where lead_id = $1", [dup]))).toBe(0);

    // contacts: only the duplicate was followed
    const ids = await asAdmin(async (q) => {
      const k = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'עוקב', $2) returning id", [org, owner.id])).rows[0].id;
      const d = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'עוקב', $2) returning id", [org, owner.id])).rows[0].id;
      const ck = (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'עוקבים') returning id", [org])).rows[0].id;
      const cd = (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'עוקבים בע\"מ') returning id", [org])).rows[0].id;
      return { k, d, ck, cd };
    });
    await follow(member.id, "contact_id", ids.d);
    await merge(owner.id, "contact", ids.k, ids.d);
    expect(await followersOf("contact_id", ids.k)).toEqual([member.id]);

    // companies: a follower of the duplicate company ends up on the kept one
    await follow(third.id, "company_id", ids.cd);
    await merge(owner.id, "company", ids.ck, ids.cd);
    expect(await followersOf("company_id", ids.ck)).toEqual([third.id]);
    expect(await asAdmin((q) => count(q, "select 1 from public.companies where id = $1", [ids.cd]))).toBe(0);

    // nobody follows either record: nothing appears
    const k3 = await insertLead(owner.id, org, { full_name: "ללא עוקבים א" });
    const d3 = await insertLead(owner.id, org, { full_name: "ללא עוקבים ב" });
    await merge(owner.id, "lead", k3, d3);
    expect(await followersOf("lead_id", k3)).toEqual([]);
  });

  it("a follower who may not read the kept record does not move (visibility own)", async () => {
    const seer = await addMember(org, owner.id, "member", "merge-seer");
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const keep = await insertLead(owner.id, org, { full_name: "של הבעלים", owner_id: owner.id });
      const dup = await insertLead(seer.id, org, { full_name: "של החבר", owner_id: seer.id });
      await asUser(seer.id, (q) => q("insert into public.record_followers (organization_id, lead_id) values ($1, $2)", [org, dup]));
      await merge(owner.id, "lead", keep, dup);
      expect(await asAdmin((q) => count(q, "select 1 from public.record_followers where user_id = $1", [seer.id]))).toBe(0);
      expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1", [dup]))).toBe(0);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("deal participants: a clash keeps the kept contact's role; a deal of the duplicate alone moves with its role", async () => {
    const pipe = await defaultPipeline(org);
    const r = await asAdmin(async (q) => {
      const keep = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'רות', $2) returning id", [org, owner.id])).rows[0].id;
      const dup = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'רות', $2) returning id", [org, owner.id])).rows[0].id;
      const both = (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'שתיהן', $2, $3) returning id", [org, pipe.pipelineId, pipe.stages[0].id])).rows[0].id;
      const only = (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'רק הכפולה', $2, $3) returning id", [org, pipe.pipelineId, pipe.stages[0].id])).rows[0].id;
      await q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role) values ($1, $2, $3, 'decision_maker'), ($1, $2, $4, 'influencer'), ($1, $5, $4, 'user')", [org, both, keep, dup, only]);
      return { keep, dup, both, only };
    });
    await merge(owner.id, "contact", r.keep, r.dup);
    const rows = await asAdmin(async (q) =>
      (await q<{ deal_id: string; contact_id: string; role: string }>("select deal_id, contact_id, role from public.deal_contacts where deal_id = any($1)", [[r.both, r.only]])).rows,
    );
    expect(rows.length).toBe(2);
    expect(rows.find((x) => x.deal_id === r.both)).toEqual({ deal_id: r.both, contact_id: r.keep, role: "decision_maker" });
    expect(rows.find((x) => x.deal_id === r.only)).toEqual({ deal_id: r.only, contact_id: r.keep, role: "user" });
  });

  it("refuses what is not allowed", async () => {
    const a = await insertLead(member.id, org, { full_name: "א", owner_id: member.id });
    const b = await insertLead(member.id, org, { full_name: "ב", owner_id: member.id });
    // a member may edit but not delete: no merging
    expect((await pgError(merge(member.id, "lead", a, b))).code).toBe("42501");
    // another business
    expect((await pgError(asUser(outsider.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, a, b])))).code).toBe("42501");
    // a column that is not on the list, itself, an unknown type
    expect((await pgError(merge(owner.id, "lead", a, b, { organization_id: "merge" }))).code).toBe("22023");
    expect((await pgError(merge(owner.id, "lead", a, a))).code).toBe("22023");
    expect((await pgError(merge(owner.id, "deal", a, b))).code).toBe("22023");
    // nothing changed
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = any($1)", [[a, b]]))).toBe(2);
  });
});
