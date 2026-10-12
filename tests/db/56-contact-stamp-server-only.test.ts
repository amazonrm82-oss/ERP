import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// RVW-12: last / first contact are the server's (LEAD-02 stamp), not a field a client sets.
describe("last contact is written by the server only (RVW-12)", () => {
  let owner: U;
  let org: string, lead: string, contact: string;

  beforeAll(async () => {
    owner = await createUser("stamp-owner");
    org = await createOrg(owner.id);
    lead = await insertLead(owner.id, org, { full_name: "ליד" });
    contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id,
    );
  });

  const stamps = (table: "leads" | "contacts", id: string) =>
    asAdmin(async (q) => (await q<{ last: Date | null }>(`select last_contacted_at as last from public.${table} where id = $1`, [id])).rows[0].last);

  it("a client cannot set them, on update or on insert, not even the owner", async () => {
    for (const set of ["last_contacted_at = now()", "first_contacted_at = now()", "last_contacted_at = null"]) {
      expect((await pgError(asUser(owner.id, (q) => q(`update public.leads set ${set} where id = $1`, [lead])))).code, set).toBe("42501");
    }
    expect((await pgError(asUser(owner.id, (q) => q("update public.contacts set last_contacted_at = now() where id = $1", [contact])))).code).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.leads (organization_id, full_name, last_contacted_at) values ($1, 'x', now())", [org])))).code,
    ).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.leads (organization_id, full_name, first_contacted_at) values ($1, 'x', now())", [org])))).code,
    ).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.contacts (organization_id, first_name, last_contacted_at) values ($1, 'x', now())", [org])))).code,
    ).toBe("42501");
    expect(await stamps("leads", lead)).toBeNull();
    expect(await stamps("contacts", contact)).toBeNull();
  });

  it("the other contact columns are written as before", async () => {
    const row = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `update public.contacts set first_name = 'דנה', last_name = 'כהן', email = 'dana@example.com', phone = '050-1234567', job_title = 'מנהלת',
                  city = 'חיפה', address_line = 'הרצל 1', birth_date = '1990-01-02', preferred_locale = 'he', contact_type = 'customer',
                  owner_id = $2, tag_ids = '{}', custom_fields = '{}', deleted_at = null
            where id = $1 returning id`,
          [contact, owner.id],
        )
      ).rows,
    );
    expect(row).toHaveLength(1);
  });

  it("logging contact still stamps both, through the trigger", async () => {
    await asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה', $2)", [org, lead]));
    await asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, contact_id) values ($1, 'note', 'הערה', $2)", [org, contact]));
    expect(await stamps("leads", lead)).not.toBeNull();
    expect(await stamps("contacts", contact)).not.toBeNull();
  });
});
