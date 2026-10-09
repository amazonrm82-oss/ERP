import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, closePool, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

const MIGRATION = readFileSync(join(process.cwd(), "supabase/migrations/20261006004900_rename_qualified_status.sql"), "utf8");

describe("existing businesses: 'מוסמך' becomes 'מתאים' (FXU-08, migration 0049)", () => {
  it("renames the old status in place, keeps its leads, and leaves a business that has both alone", async () => {
    const owner = await createUser("rename-owner");
    const [oldOrg, bothOrg] = [await createOrg(owner.id), await createOrg(owner.id)];
    // businesses opened before 0047 had "מוסמך"
    await asAdmin((q) => q("update public.lead_statuses set name = 'מוסמך' where organization_id = any($1) and name = 'מתאים'", [[oldOrg, bothOrg]]));
    await asAdmin((q) => q("insert into public.lead_statuses (organization_id, name, kind, position) values ($1, 'מתאים', 'open', 9)", [bothOrg]));
    const statusId = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.lead_statuses where organization_id = $1 and name = 'מוסמך'", [oldOrg])).rows[0].id);
    const lead = await insertLead(owner.id, oldOrg, { status_id: statusId });

    await asAdmin((q) => q(MIGRATION));
    await asAdmin((q) => q(MIGRATION)); // twice is harmless

    const names = (org: string) =>
      asAdmin(async (q) => (await q<{ name: string }>("select name from public.lead_statuses where organization_id = $1 order by position, name", [org])).rows.map((r) => r.name));
    expect(await names(oldOrg)).toContain("מתאים");
    expect(await names(oldOrg)).not.toContain("מוסמך");
    expect((await names(bothOrg)).filter((n) => n === "מוסמך" || n === "מתאים").sort()).toEqual(["מוסמך", "מתאים"]);
    const kept = await asAdmin(async (q) => (await q<{ status_id: string }>("select status_id from public.leads where id = $1", [lead])).rows[0].status_id);
    expect(kept).toBe(statusId);
  });
});
