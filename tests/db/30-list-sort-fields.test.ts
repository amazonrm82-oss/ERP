import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

describe("sorting lists by status, source, owner and company (computed fields)", () => {
  let owner: { id: string }, avi: { id: string }, outsider: { id: string };
  let org: string, otherOrg: string;

  beforeAll(async () => {
    owner = await createUser("sort-owner");
    org = await createOrg(owner.id);
    avi = await addMember(org, owner.id, "admin", "אבי");
    outsider = await createUser("sort-outsider");
    otherOrg = await createOrg(outsider.id);
    await asAdmin((q) => q("update public.profiles set full_name = 'תמר' where id = $1", [owner.id]));
  });

  const statusId = (name: string) =>
    asAdmin(async (q) => (await q<{ id: string }>("select id from public.lead_statuses where organization_id = $1 and name = $2", [org, name])).rows[0].id);

  it("leads order by status position, source name and owner name", async () => {
    const [newStatus, working] = [await statusId("חדש"), await statusId("בטיפול")];
    const [web, phone] = await asAdmin(async (q) => [
      (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'אתר') returning id", [org])).rows[0].id,
      (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'טלפון') returning id", [org])).rows[0].id,
    ]);
    const a = await insertLead(owner.id, org, { full_name: "א", status_id: working, source_id: phone, owner_id: owner.id });
    const b = await insertLead(owner.id, org, { full_name: "ב", status_id: newStatus, source_id: web, owner_id: avi.id });

    const order = (by: string) =>
      asUser(owner.id, async (q) =>
        (await q<{ id: string }>(`select l.id from public.leads l where l.id = any ($1) order by public.${by}(l), l.id`, [[a, b]])).rows.map((r) => r.id),
      );
    expect(await order("sort_status")).toEqual([b, a]); // "חדש" comes before "בטיפול" in the settings
    expect(await order("sort_source")).toEqual([b, a]); // אתר < טלפון
    expect(await order("sort_owner")).toEqual([b, a]); // אבי < תמר
  });

  it("contacts order by company name and owner; companies by owner", async () => {
    const [x, y] = await asUser(owner.id, async (q) => [
      (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'זית') returning id", [org])).rows[0].id,
      (await q<{ id: string }>("insert into public.companies (organization_id, name, owner_id) values ($1, 'אלון', $2) returning id", [org, avi.id])).rows[0].id,
    ]);
    const [c1, c2] = await asUser(owner.id, async (q) => [
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, company_id) values ($1, 'ראשון', $2) returning id", [org, x])).rows[0].id,
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, company_id) values ($1, 'שני', $2) returning id", [org, y])).rows[0].id,
    ]);
    const contacts = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("select c.id from public.contacts c where c.id = any ($1) order by public.sort_company(c)", [[c1, c2]])).rows.map((r) => r.id),
    );
    expect(contacts).toEqual([c2, c1]); // אלון < זית
    const companies = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("select c.id from public.companies c where c.id = any ($1) order by public.sort_owner(c)", [[x, y]])).rows.map((r) => r.id),
    );
    expect(companies).toEqual([y, x]); // אבי < תמר
  });

  it("reads with the caller's rights: another organization's names stay hidden", async () => {
    // a lead row of this organization, pointed at the other organization's source in memory (as if forged)
    const theirSource = await asAdmin(
      async (q) => (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'סודי') returning id", [otherOrg])).rows[0].id,
    );
    const lead = await insertLead(owner.id, org);
    const shown = await asUser(owner.id, async (q) =>
      (
        await q<{ name: string | null }>(
          "select public.sort_source(jsonb_populate_record(r, jsonb_build_object('organization_id', $2::uuid, 'source_id', $3::uuid))) as name from public.leads r where r.id = $1",
          [lead, otherOrg, theirSource],
        )
      ).rows[0].name,
    );
    expect(shown).toBeNull();
    // and someone outside the organization learns nothing about its owners
    const outside = await asUser(outsider.id, async (q) =>
      (await q<{ name: string | null }>("select public.sort_owner(l) as name from public.leads l where l.id = $1", [lead])).rows,
    );
    expect(outside).toEqual([]);
  });
});
