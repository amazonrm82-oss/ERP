import { afterAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, closePool, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

describe("notifications address the user in the plural (FXU-09)", () => {
  it("a lead assigned to someone else tells them 'ליד חדש הוקצה לכם'", async () => {
    const owner = await createUser("plural-owner");
    const org = await createOrg(owner.id);
    const member = await addMember(org, owner.id, "member");
    const lead = await insertLead(owner.id, org, { owner_id: member.id });
    const titles = await asAdmin(async (q) =>
      (await q<{ title: string }>("select title from public.notifications where organization_id = $1 and entity_id = $2", [org, lead])).rows.map((r) => r.title),
    );
    expect(titles).toEqual(["ליד חדש הוקצה לכם"]);
  });
});
