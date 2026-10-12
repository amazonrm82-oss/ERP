import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// RVW-11: from the browser a person logs only the six contact types, and an entry has a size.
describe("what a person may write on a timeline (RVW-11)", () => {
  let owner: U, member: U;
  let org: string, lead: string;

  beforeAll(async () => {
    owner = await createUser("acttype-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "acttype-member");
    lead = await insertLead(member.id, org, { full_name: "ליד" });
  });

  const insert = (user: U, type: string, body: string | null = "x", metadata: unknown = {}) =>
    asUser(user.id, async (q) =>
      (
        await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id, metadata) values ($1, $2, $3, $4, $5) returning id", [
          org,
          type,
          body,
          lead,
          JSON.stringify(metadata),
        ])
      ).rows[0].id,
    );

  it("a member and an admin log the six contact types", async () => {
    for (const type of ["note", "call", "meeting", "email", "whatsapp", "sms"]) {
      expect(await insert(member, type)).toBeTruthy();
    }
    expect(await insert(owner, "call", "שיחה", { outcome: "answered" })).toBeTruthy();
  });

  it("no one writes a system type from the browser, not even the owner", async () => {
    for (const type of ["inquiry", "status_change", "stage_change", "conversion", "assignment", "system", "form_submission"]) {
      for (const user of [member, owner]) {
        expect((await pgError(insert(user, type))).code, `${type}`).toBe("42501");
      }
    }
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1 and not (type = any (app.contact_types()))", [lead]))).toBe(0);
  });

  it("the server still writes its own types", async () => {
    await asUser(member.id, (q) => q("select public.convert_lead($1, false, null, null)", [lead]));
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1 and type = 'conversion'", [lead]))).toBe(1);
  });

  it("a body longer than 10,000 characters is refused, for every writer", async () => {
    expect(await insert(member, "note", "א".repeat(10_000))).toBeTruthy();
    expect((await pgError(insert(member, "note", "א".repeat(10_001)))).code).toBe("23514");
    const id = await insert(member, "note", "קצר");
    expect((await pgError(asUser(member.id, (q) => q("update public.activities set body = $1 where id = $2", ["א".repeat(10_001), id])))).code).toBe("23514");
    expect(
      (await pgError(asAdmin((q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'system', $2, $3)", [org, "א".repeat(10_001), lead])))).code,
    ).toBe("23514");
  });

  it("metadata over 4 KB from the browser is refused, on insert and on update; the server is not limited", async () => {
    const big = { outcome: "x".repeat(5000) };
    expect(await insert(member, "call", "x", { outcome: "x".repeat(4000) })).toBeTruthy();
    const err = await pgError(insert(member, "call", "x", big));
    expect(err.code).toBe("23514");
    expect(err.hint).toBe("activity:too_large");

    const id = await insert(member, "call", "x", { outcome: "answered" });
    expect((await pgError(asUser(member.id, (q) => q("update public.activities set metadata = $1 where id = $2", [JSON.stringify(big), id])))).code).toBe("23514");

    // a large server entry (like a merge snapshot) is written, and a person can still pin it
    const server = await asAdmin(async (q) =>
      (
        await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id, metadata, created_by) values ($1, 'note', 'x', $2, $3, $4) returning id", [
          org,
          lead,
          JSON.stringify(big),
          member.id,
        ])
      ).rows[0].id,
    );
    expect((await asUser(member.id, (q) => q("update public.activities set is_pinned = true, body = 'נערך' where id = $1", [server]))).rowCount).toBe(1);
  });
});
