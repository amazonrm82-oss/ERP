import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

/**
 * RVW-58: organizations.timezone is read as it is by many functions (`at time zone o.timezone`). A new or changed value
 * must be a name in pg_timezone_names, for every writer (hint org:timezone); rows already stored are not rewritten.
 */
describe("business time zone check (RVW-58)", () => {
  let owner: { id: string };
  let org: string;
  const zoneOf = () =>
    asAdmin(async (q) => (await q<{ z: string }>("select timezone as z from public.organizations where id = $1", [org])).rows[0].z);

  beforeAll(async () => {
    owner = await createUser("tz-owner");
    org = await createOrg(owner.id, "עסק אזור זמן");
  });

  it("a new business gets a valid default", async () => {
    expect(await zoneOf()).toBe("Asia/Jerusalem");
  });

  it("an owner may set a known zone and is refused an unknown one", async () => {
    const set = (zone: string) => asUser(owner.id, (q) => q("update public.organizations set timezone = $2 where id = $1 returning id", [org, zone]));
    for (const bad of ["Mars/Base", "not a zone", "", "asia/jerusalem ", "Asia/Jerusalem ", "posixrules", "Factory", "localtime", "Japan", "GMT", "EST5EDT"]) {
      expect(await pgError(set(bad)), bad).toMatchObject({ code: "P0001", hint: "org:timezone" });
    }
    expect(await zoneOf()).toBe("Asia/Jerusalem");
    expect((await set("Europe/London")).rowCount).toBe(1);
    expect(await zoneOf()).toBe("Europe/London");
    for (const good of ["UTC", "Etc/GMT+2", "America/Argentina/Buenos_Aires"]) expect((await set(good)).rowCount, good).toBe(1);
  });

  it("server writes and inserts are checked too", async () => {
    expect(await pgError(asAdmin((q) => q("update public.organizations set timezone = 'Mars/Base' where id = $1", [org])))).toMatchObject({
      hint: "org:timezone",
    });
    expect(
      await pgError(
        asAdmin((q) => q("insert into public.organizations (name, slug, timezone) values ('זמן שגוי', 'tz-bad-zone-rvw58', 'Nowhere/City')")),
      ),
    ).toMatchObject({ hint: "org:timezone" });
  });

  it("a stored value is not judged again when other columns change", async () => {
    // an old row with an unknown zone, as it may exist from before the check (written with triggers off)
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.organizations set timezone = 'Mars/Base' where id = $1", [org]);
    });
    await asAdmin((q) => q("update public.organizations set name = 'עסק אזור זמן 2' where id = $1", [org]));
    await asAdmin((q) => q("update public.organizations set timezone = 'Mars/Base', name = 'עסק אזור זמן 3' where id = $1", [org]));
    await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    expect(await zoneOf()).toBe("Asia/Jerusalem");
  });
});
