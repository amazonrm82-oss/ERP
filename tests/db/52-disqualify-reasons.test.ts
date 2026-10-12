import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// LEAD-03: a "not relevant" status needs a reason from the organization's own list.
describe("disqualify reasons (LEAD-03)", () => {
  let owner: U, member: U;
  let org: string, disqualified: string, open: string;

  beforeAll(async () => {
    owner = await createUser("dq-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "dq-member");
    const statuses = await asAdmin(async (q) =>
      (await q<{ id: string; kind: string; is_default: boolean }>("select id, kind, is_default from public.lead_statuses where organization_id = $1", [org])).rows,
    );
    disqualified = statuses.find((s) => s.kind === "disqualified")!.id;
    open = statuses.find((s) => s.kind === "open" && !s.is_default)!.id;
    // the organization starts with the default reasons (0076); these tests start from a list the business emptied
    await asUser(owner.id, (q) => q("delete from public.disqualify_reasons where organization_id = $1", [org]));
  });

  const setStatus = (user: U, lead: string, status: string, reason: string | null) =>
    asUser(user.id, async (q) => (await q("update public.leads set status_id = $1, disqualify_reason = $2 where id = $3", [status, reason, lead])).rowCount);
  const addReason = (name: string, active = true) =>
    asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.disqualify_reasons (organization_id, name, is_active) values ($1, $2, $3) returning id", [org, name, active])).rows[0].id,
    );

  it("with an empty list, any reason will do, but not none", async () => {
    const lead = await insertLead(member.id, org);
    const error = await pgError(setStatus(member, lead, disqualified, "  "));
    expect(error.code).toBe("P0001");
    expect(error.hint).toBe("lead:disqualify_reason");
    expect((await pgError(setStatus(member, lead, disqualified, null))).hint).toBe("lead:disqualify_reason");
    expect(await setStatus(member, lead, disqualified, "סיבה חופשית")).toBe(1);
  });

  it("once the organization has reasons, only an active one from the list is accepted", async () => {
    await addReason("קנה אצל מתחרה");
    await addReason("סיבה ישנה", false);
    const lead = await insertLead(member.id, org);
    expect((await pgError(setStatus(member, lead, disqualified, "סיבה חופשית"))).hint).toBe("lead:disqualify_reason");
    expect((await pgError(setStatus(member, lead, disqualified, "סיבה ישנה"))).hint).toBe("lead:disqualify_reason");
    expect(await setStatus(member, lead, disqualified, "קנה אצל מתחרה")).toBe(1);
    // changing only the reason of a disqualified lead is checked too
    expect((await pgError(asUser(member.id, (q) => q("update public.leads set disqualify_reason = 'משהו אחר' where id = $1", [lead])))).hint).toBe(
      "lead:disqualify_reason",
    );
    // a change of something else on a lead whose old reason left the list goes through
    await asUser(owner.id, (q) => q("update public.disqualify_reasons set name = 'קנה אצל המתחרים' where organization_id = $1 and name = 'קנה אצל מתחרה'", [org]));
    expect(await asUser(member.id, async (q) => (await q("update public.leads set full_name = 'שם אחר' where id = $1", [lead])).rowCount)).toBe(1);
    // back to an open status: no reason needed
    expect(await setStatus(member, lead, open, null)).toBe(1);
  });

  it("server-side changes are not checked here; a new lead from a person is (RVW-9)", async () => {
    const lead = await insertLead(member.id, org);
    await asAdmin((q) => q("update public.leads set status_id = $1, disqualify_reason = null where id = $2", [disqualified, lead]));
    const row = await asAdmin(async (q) => (await q<{ status_id: string }>("select status_id from public.leads where id = $1", [lead])).rows[0]);
    expect(row.status_id).toBe(disqualified);
    // since 0092 a person's new lead follows the same rule as a status change
    expect((await pgError(insertLead(member.id, org, { status_id: disqualified }))).hint).toBe("lead:disqualify_reason");
  });

  it("names are unique per organization (ignoring case) and trimmed; at most 50", async () => {
    await addReason("Spam");
    expect((await pgError(addReason("spam"))).code).toBe("23505");
    expect((await pgError(addReason(" רווח "))).code).toBe("23514");
    const other = await createUser("dq-other");
    const otherOrg = await createOrg(other.id, "עסק אחר");
    await asUser(other.id, (q) => q("delete from public.disqualify_reasons where organization_id = $1", [otherOrg]));
    // the same name in another organization is fine
    await asUser(other.id, (q) => q("insert into public.disqualify_reasons (organization_id, name) values ($1, 'Spam')", [otherOrg]));
    await asUser(other.id, (q) =>
      q("insert into public.disqualify_reasons (organization_id, name) select $1, 'סיבה ' || g from generate_series(1, 49) g", [otherOrg]),
    );
    const error = await pgError(asUser(other.id, (q) => q("insert into public.disqualify_reasons (organization_id, name) values ($1, 'עוד אחת')", [otherOrg])));
    expect(error.code).toBe("P0001");
    expect(error.hint).toBe("reasons:max");
  });

  it("a change to the list is written to the audit log", async () => {
    const id = await addReason("לא עונה");
    const entries = await asAdmin(async (q) =>
      (await q<{ action: string }>("select action from public.audit_log where entity_type = 'disqualify_reasons' and entity_id = $1", [id])).rows,
    );
    expect(entries.map((e) => e.action)).toEqual(["insert"]);
  });
});
