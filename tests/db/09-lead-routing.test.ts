import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Result = { status: string; lead_id?: string; contact_id?: string };

const submit = (token: string, payload: Record<string, unknown>) =>
  asService(async (q) => {
    const res = await q<{ result: Result }>("select public.intake_submit($1, 'webhook', $2) as result", [token, JSON.stringify(payload)]);
    return res.rows[0].result;
  });

const ownerOf = (leadId: string) =>
  asAdmin(async (q) => (await q<{ owner_id: string | null }>("select owner_id from public.leads where id = $1", [leadId])).rows[0].owner_id);

describe("lead routing and repeat inquiries", () => {
  let owner: U, rep1: U, rep2: U, rep3: U, viewer: U;
  let org: string;
  let team: string;
  let hook: { id: string; token: string };

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    rep1 = await addMember(org, owner.id, "member", "rep1");
    rep2 = await addMember(org, owner.id, "member", "rep2");
    rep3 = await addMember(org, owner.id, "member", "rep3");
    viewer = await addMember(org, owner.id, "viewer", "viewer");
    await asUser(owner.id, async (q) => {
      team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      for (const user of [rep1, rep2, rep3, viewer]) {
        await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, user.id]);
      }
      hook = (
        await q<{ id: string; token: string }>(
          "insert into public.forms (organization_id, kind, name, owner_id) values ($1, 'webhook', 'קליטה', $2) returning id, token",
          [org, owner.id],
        )
      ).rows[0];
    });
  });

  it("a repeat inquiry by phone (any format) goes onto the existing lead, and its owner is told", async () => {
    const first = await submit(hook.token, { full_name: "יוסי", phone: "050-1112222", message: "פנייה ראשונה" });
    expect(first.status).toBe("accepted");
    const again = await submit(hook.token, { full_name: "יוסי שוב", phone: "+972 50 111 2222", message: "שוב אני" });
    expect(again).toMatchObject({ status: "duplicate", lead_id: first.lead_id });

    await asAdmin(async (q) => {
      expect(await count(q, "select 1 from public.leads where organization_id = $1 and phone_e164 = '+972501112222'", [org])).toBe(1);
      const inquiry = (
        await q<{ body: string; metadata: { full_name: string } }>(
          "select body, metadata from public.activities where lead_id = $1 and type = 'inquiry'",
          [first.lead_id],
        )
      ).rows;
      expect(inquiry).toHaveLength(1);
      expect(inquiry[0].body).toBe("שוב אני");
      expect(inquiry[0].metadata.full_name).toBe("יוסי שוב");
      expect(await count(q, "select 1 from public.form_submissions where form_id = $1 and status = 'duplicate'", [hook.id])).toBe(1);
    });
    const leadOwner = await ownerOf(first.lead_id!);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'inquiry'", [leadOwner]))).toBe(1);
  });

  it("matches by email too (case-insensitive), and a contact without a lead", async () => {
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email) values ($1, 'רינה', 'Rina@Example.com') returning id", [org]))
        .rows[0].id,
    );
    const result = await submit(hook.token, { full_name: "רינה", email: "rina@example.COM" });
    expect(result).toMatchObject({ status: "duplicate", contact_id: contact });
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where contact_id = $1 and type = 'inquiry'", [contact]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and lower(email) = 'rina@example.com'", [org]))).toBe(0);
  });

  it("an inquiry about a converted lead shows on the lead and on the contact it became", async () => {
    const lead = (await submit(hook.token, { full_name: "דן המרה", phone: "052-3334444" })).lead_id!;
    const converted = await asUser(owner.id, async (q) =>
      (await q<{ r: { contact_id: string } }>("select public.convert_lead($1, false) as r", [lead])).rows[0].r,
    );
    const again = await submit(hook.token, { phone: "0523334444" });
    expect(again).toMatchObject({ status: "duplicate", lead_id: lead, contact_id: converted.contact_id });
    expect(
      await asAdmin((q) => count(q, "select 1 from public.activities where type = 'inquiry' and lead_id = $1 and contact_id = $2", [lead, converted.contact_id])),
    ).toBe(1);
  });

  it("a lead in the recycle bin does not count as a match", async () => {
    const lead = (await submit(hook.token, { full_name: "בסל", phone: "053-5556666" })).lead_id!;
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
    const again = await submit(hook.token, { full_name: "בסל", phone: "053-5556666" });
    expect(again.status).toBe("accepted");
    expect(again.lead_id).not.toBe(lead);
  });

  it("round robin rotates among available team members and skips the unavailable, the suspended and viewers", async () => {
    await asUser(owner.id, (q) => q("update public.forms set assign_mode = 'round_robin', team_id = $2 where id = $1", [hook.id, team]));
    // rep3 is on vacation (they mark it themselves)
    await asUser(rep3.id, (q) => q("update public.memberships set is_available = false where organization_id = $1 and user_id = $2", [org, rep3.id]));

    const owners: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await submit(hook.token, { full_name: `סבב ${i}`, phone: `054-000000${i}` });
      owners.push((await ownerOf(result.lead_id!))!);
    }
    expect(new Set(owners)).toEqual(new Set([rep1.id, rep2.id]));
    // strictly alternating
    expect(owners[0]).not.toBe(owners[1]);
    expect(owners[2]).toBe(owners[0]);
    expect(owners[3]).toBe(owners[1]);

    // rep2 suspended: only rep1 is left
    await asUser(owner.id, (q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, rep2.id]));
    for (let i = 0; i < 2; i++) {
      const result = await submit(hook.token, { full_name: `אחד ${i}`, phone: `054-100000${i}` });
      expect(await ownerOf(result.lead_id!)).toBe(rep1.id);
    }
    await asUser(owner.id, (q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, rep2.id]));
  });

  it("with nobody available, the lead goes to the form's fixed owner", async () => {
    for (const rep of [rep1, rep2]) {
      await asUser(rep.id, (q) => q("update public.memberships set is_available = false where organization_id = $1 and user_id = $2", [org, rep.id]));
    }
    const result = await submit(hook.token, { full_name: "אין זמינים", phone: "055-7778888" });
    expect(await ownerOf(result.lead_id!)).toBe(owner.id);
  });

  it("the rotation's memory is server-only and stays out of the audit log", async () => {
    const write = await pgError(
      asUser(owner.id, (q) => q("update public.memberships set last_lead_assigned_at = now() where organization_id = $1", [org])),
    );
    expect(write.code).toBe("42501");
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'memberships' and changes ? 'last_lead_assigned_at'", [org]),
      ),
    ).toBe(0);
    const badMode = await pgError(asUser(owner.id, (q) => q("update public.forms set assign_mode = 'random' where id = $1", [hook.id])));
    expect(badMode.code).toBe("23514");
  });
});
