import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

/** CAL-03: the organization's rest days (public.org_calendar_settings). */
describe("the organization's rest days", () => {
  let owner: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("rest-owner");
    org = await createOrg(owner.id);
  });

  it("starts with no row; the defaults are Friday and Saturday, holidays off, erev days at work", async () => {
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.org_calendar_settings where organization_id = $1", [org]))).toBe(0);
    const row = await asUser(owner.id, async (q) =>
      (
        await q<{ rest_weekdays: number[]; holidays_rest: boolean; holiday_eves_rest: boolean; updated_by: string }>(
          "insert into public.org_calendar_settings (organization_id) values ($1) returning rest_weekdays, holidays_rest, holiday_eves_rest, updated_by",
          [org],
        )
      ).rows[0],
    );
    expect(row).toEqual({ rest_weekdays: [5, 6], holidays_rest: true, holiday_eves_rest: false, updated_by: owner.id });
  });

  it("one row per organization", async () => {
    const again = await pgError(asUser(owner.id, (q) => q("insert into public.org_calendar_settings (organization_id) values ($1)", [org])));
    expect(again.code).toBe("23505");
  });

  it("keeps the weekdays in range and leaves at least one work day", async () => {
    for (const days of ["{7}", "{-1}", "{0,1,2,3,4,5,6}", "{5,null}"]) {
      const err = await pgError(
        asUser(owner.id, (q) => q("update public.org_calendar_settings set rest_weekdays = $2 where organization_id = $1", [org, days])),
      );
      expect(err.code, days).toBe("23514");
    }
    await asUser(owner.id, async (q) => {
      expect((await q("update public.org_calendar_settings set rest_weekdays = '{}' where organization_id = $1", [org])).rowCount).toBe(1);
      expect((await q("update public.org_calendar_settings set rest_weekdays = '{6}', holiday_eves_rest = true where organization_id = $1", [org])).rowCount).toBe(1);
    });
  });

  it("every change is in the audit log", async () => {
    const actions = await asAdmin(async (q) =>
      (
        await q<{ action: string }>(
          "select action from public.audit_log where organization_id = $1 and entity_type = 'org_calendar_settings' order by id",
          [org],
        )
      ).rows.map((r) => r.action),
    );
    expect(actions).toEqual(["insert", "update", "update"]);
  });

  it("a row cannot move to another organization", async () => {
    const err = await pgError(
      asUser(owner.id, (q) => q("update public.org_calendar_settings set organization_id = organization_id where organization_id = $1", [org])),
    );
    expect(err.code).toBe("42501");
  });

  it("someone from another organization cannot create the row", async () => {
    const stranger = await createUser("rest-stranger");
    await createOrg(stranger.id);
    const fresh = await createOrg(owner.id, "עסק בלי הגדרות");
    const err = await pgError(asUser(stranger.id, (q) => q("insert into public.org_calendar_settings (organization_id) values ($1)", [fresh])));
    expect(err.code).toBe("42501");
  });

  it("a read-only organization keeps its rest days but cannot change them", async () => {
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.org_calendar_settings where organization_id = $1", [org])).toBe(1);
      expect((await q("update public.org_calendar_settings set holidays_rest = false where organization_id = $1", [org])).rowCount).toBe(0);
      expect((await q("delete from public.org_calendar_settings where organization_id = $1", [org])).rowCount).toBe(0);
    });
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
  });
});
