import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type Match = { id: string; phone_e164: string | null; email: string | null; tax_id: string | null; name: string | null };

const find = (userId: string, org: string, entity: string, phones: string[], emails: string[], taxIds: string[] = [], names: string[] = []) =>
  asUser(userId, async (q) =>
    (await q<Match>("select * from public.import_find_duplicates($1, $2, $3, $4, $5, $6)", [org, entity, phones, emails, taxIds, names])).rows,
  );

describe("import duplicates are found in the database (FXC-02)", () => {
  let owner: { id: string }, member: { id: string }, stranger: { id: string };
  let org: string, otherOrg: string;
  let lead: string, company: string;

  beforeAll(async () => {
    owner = await createUser("dup-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "dup-member");
    stranger = await createUser("dup-stranger");
    otherOrg = await createOrg(stranger.id);
    lead = await insertLead(owner.id, org, { full_name: "דנה", email: "Dana@Example.com", phone: "052-1234567" });
    await insertLead(stranger.id, otherOrg, { full_name: "דנה", email: "dana@example.com" });
    company = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("insert into public.companies (organization_id, name, tax_id) values ($1, 'Acme בע\"מ', '512345678') returning id", [org])).rows[0].id,
    );
  });

  it("emails match without case, phones by their E.164 form, only in the organization", async () => {
    const byEmail = await find(owner.id, org, "lead", [], ["dana@EXAMPLE.com"]);
    expect(byEmail.map((m) => m.id)).toEqual([lead]);
    const byPhone = await find(owner.id, org, "lead", ["+972521234567"], []);
    expect(byPhone.map((m) => m.id)).toEqual([lead]);
    expect(await find(owner.id, org, "contact", ["+972521234567"], ["dana@example.com"])).toEqual([]);
  });

  it("companies match by tax id or by name without case", async () => {
    expect((await find(owner.id, org, "company", [], [], ["512345678"])).map((m) => m.id)).toEqual([company]);
    expect((await find(owner.id, org, "company", [], [], [], ['ACME בע"מ'])).map((m) => m.id)).toEqual([company]);
  });

  it("reads with the caller's rights", async () => {
    // the other organization's lead is invisible, even when asked for by its id
    expect(await find(stranger.id, org, "lead", [], ["dana@example.com"])).toEqual([]);
    // with "own" visibility a member does not see the owner's lead
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    expect(await find(member.id, org, "lead", [], ["dana@example.com"])).toEqual([]);
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    const anon = await pgError(asAnon((q) => q("select * from public.import_find_duplicates($1, 'lead', '{}', '{}', '{}', '{}')", [org])));
    expect(anon.code).toBe("42501");
  });

  it("a contacts import may tag the companies it creates; a leads import may not", async () => {
    const job = (entity: string) =>
      asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows) values ($1, $2, 'f.csv', 'skip', 1) returning id",
            [org, entity],
          )
        ).rows[0].id,
      );
    const contactsJob = await job("contact");
    const created = await asUser(owner.id, (q) =>
      q("insert into public.companies (organization_id, name, import_job_id) values ($1, 'חברה מהייבוא', $2) returning id", [org, contactsJob]),
    );
    expect(created.rowCount).toBe(1);
    const leadsJob = await job("lead");
    const err = await pgError(asUser(owner.id, (q) => q("insert into public.companies (organization_id, name, import_job_id) values ($1, 'אחרת', $2)", [org, leadsJob])));
    expect(err.code).toBe("42501");
  });
});
