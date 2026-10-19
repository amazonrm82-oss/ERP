import { afterAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

// USR-07 (owner, 18 October 2026): profiles.theme is null (by the device), 'light' or 'dark'; a person sets only their own.
describe("a person's own theme (USR-07)", () => {
  const themeOf = (id: string) => asAdmin(async (q) => (await q<{ theme: string | null }>("select theme from public.profiles where id = $1", [id])).rows[0].theme);

  it("starts by the device, takes light or dark, and goes back to by the device", async () => {
    const user = await createUser("theme-user");
    expect(await themeOf(user.id)).toBeNull();
    for (const value of ["dark", "light", null]) {
      const res = await asUser(user.id, (q) => q("update public.profiles set theme = $2 where id = $1 returning id", [user.id, value]));
      expect(res.rowCount).toBe(1);
      expect(await themeOf(user.id)).toBe(value);
    }
  });

  it("refuses anything but light or dark", async () => {
    const user = await createUser("theme-bad");
    for (const value of ["sepia", "Dark", ""]) {
      expect((await pgError(asUser(user.id, (q) => q("update public.profiles set theme = $2 where id = $1", [user.id, value])))).code, value).toBe("23514");
    }
  });

  it("a colleague cannot change someone else's theme", async () => {
    const owner = await createUser("theme-owner");
    const org = await createOrg(owner.id, "עסק המראה");
    const member = await addMember(org, owner.id, "member", "theme-member");
    const res = await asUser(owner.id, (q) => q("update public.profiles set theme = 'dark' where id = $1", [member.id]));
    expect(res.rowCount).toBe(0);
    expect(await themeOf(member.id)).toBeNull();
  });
});
