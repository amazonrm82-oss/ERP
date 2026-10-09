import { afterAll, describe, expect, it } from "vitest";
import { asAdmin, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

describe("default lead statuses of a new business (FXU-08)", () => {
  it("calls the qualified status 'מתאים'", async () => {
    const owner = await createUser("status-owner");
    const org = await createOrg(owner.id);
    const names = await asAdmin(async (q) =>
      (await q<{ name: string }>("select name from public.lead_statuses where organization_id = $1 order by position", [org])).rows.map((r) => r.name),
    );
    expect(names).toEqual(["חדש", "נוצר קשר", "בטיפול", "לא ענה", "מתאים", "הומר", "לא רלוונטי"]);
  });
});
