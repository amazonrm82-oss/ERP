import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";
import { MIGRATIONS_DIR, migrationFile, rerunClosure } from "./rerun";

afterAll(closePool);

type U = { id: string; email: string };
type Link = { company_id: string; title: string | null; is_primary: boolean };

// CON-05: a contact linked to several companies, with a role at each and one primary. The primary is
// contacts.company_id; the link table follows it.
describe("a contact at several companies (CON-05)", () => {
  let owner: U, rep: U;
  let org: string, otherOrg: string;

  const company = (name: string, o = org, user?: U) =>
    asUser((user ?? owner).id, async (q) => (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, $2) returning id", [o, name])).rows[0].id);
  const contact = (name: string, companyId: string | null = null, user?: U) =>
    asUser((user ?? owner).id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, company_id) values ($1, $2, $3) returning id", [org, name, companyId])).rows[0].id,
    );
  const links = (contactId: string) =>
    asAdmin(async (q) =>
      (await q<Link>("select company_id, title, is_primary from public.contact_companies where contact_id = $1 order by is_primary desc, title nulls first, company_id", [contactId])).rows,
    );
  const link = (contactId: string, companyId: string, title: string | null = null, user?: U) =>
    asUser((user ?? owner).id, async (q) =>
      (await q<{ id: string }>("insert into public.contact_companies (organization_id, contact_id, company_id, title) values ($1, $2, $3, $4) returning id", [org, contactId, companyId, title])).rows[0].id,
    );
  const setCompany = (contactId: string, companyId: string | null) =>
    asUser(owner.id, (q) => q("update public.contacts set company_id = $2 where id = $1", [contactId, companyId]));

  beforeAll(async () => {
    owner = await createUser("cc-owner");
    org = await createOrg(owner.id, "עסק אנשי קשר");
    rep = await addMember(org, owner.id, "member", "cc-rep");
    const other = await createUser("cc-other");
    otherOrg = await createOrg(other.id, "עסק אחר");
  });

  it("the contact's company is its primary link; changing it moves the mark and keeps the old one as a further company", async () => {
    const [a, b] = [await company("אלפא"), await company("בטא")];
    const person = await contact("רונית", a);
    expect(await links(person)).toEqual([{ company_id: a, title: null, is_primary: true }]);

    await setCompany(person, b);
    expect(await links(person)).toEqual([
      { company_id: b, title: null, is_primary: true },
      { company_id: a, title: null, is_primary: false },
    ]);
    // a further company the person already has becomes primary without a second row
    await setCompany(person, a);
    expect((await links(person)).filter((l) => l.is_primary)).toEqual([{ company_id: a, title: null, is_primary: true }]);
    expect(await links(person)).toHaveLength(2);
    // a cleared company leaves both links, neither primary
    await setCompany(person, null);
    expect((await links(person)).every((l) => !l.is_primary)).toBe(true);
    expect(await links(person)).toHaveLength(2);
  });

  it("a new link is primary only when it is the contact's company; nobody sends the mark", async () => {
    const [a, b] = [await company("גמא"), await company("דלתא")];
    const person = await contact("שי");
    await link(person, a, "  סמנכ\"ל כספים  ");
    await link(person, b, "   ");
    expect(await links(person)).toEqual([
      { company_id: b, title: null, is_primary: false },
      { company_id: a, title: 'סמנכ"ל כספים', is_primary: false },
    ]);
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.contact_companies (organization_id, contact_id, company_id, is_primary) values ($1, $2, $3, true)", [org, person, a])))).code,
    ).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.contact_companies set is_primary = true where contact_id = $1", [person])))).code).toBe("42501");
    // the same company twice, a title too long
    expect((await pgError(link(person, a))).code).toBe("23505");
    expect((await pgError(asUser(owner.id, (q) => q("update public.contact_companies set title = $2 where contact_id = $1 and company_id = $3", [person, "x".repeat(81), a])))).code).toBe("23514");
    // 80 characters is the limit (owner, 15 October 2026)
    expect((await asUser(owner.id, (q) => q("update public.contact_companies set title = $2 where contact_id = $1 and company_id = $3", [person, "x".repeat(80), a]))).rowCount).toBe(1);
  });

  it("the primary link is not removed by hand; after the company is changed on the contact it is", async () => {
    const a = await company("אפסילון");
    const person = await contact("טל", a);
    const remove = () => asUser(owner.id, async (q) => (await q("delete from public.contact_companies where contact_id = $1 and company_id = $2", [person, a])).rowCount);
    expect((await pgError(remove())).hint).toBe("contact_company:primary");
    await setCompany(person, null);
    expect(await remove()).toBe(1);
    expect(await links(person)).toEqual([]);
  });

  it("at most 50 companies per contact from the browser", async () => {
    const person = await contact("רב חברות");
    const many = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.companies (organization_id, name) select $1, 'חברה ' || n from generate_series(1, 51) n returning id", [org])).rows.map((r) => r.id),
    );
    await asUser(owner.id, async (q) => {
      for (const id of many.slice(0, 50)) await q("insert into public.contact_companies (organization_id, contact_id, company_id) values ($1, $2, $3)", [org, person, id]);
    });
    expect((await pgError(link(person, many[50]))).hint).toBe("contact_company:max");
  });

  it("no link to another business's company, to a company in the recycle bin, or for a contact in the bin", async () => {
    const theirs = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'זרה') returning id", [otherOrg])).rows[0].id);
    const person = await contact("נוי");
    expect((await pgError(link(person, theirs))).code).toMatch(/^(42501|23503)$/);
    expect((await pgError(asAdmin((q) => q("insert into public.contact_companies (organization_id, contact_id, company_id) values ($1, $2, $3)", [org, person, theirs])))).code).toBe("23503");

    const binned = await company("בפח");
    await asUser(owner.id, (q) => q("update public.companies set deleted_at = now() where id = $1", [binned]));
    expect((await pgError(link(person, binned))).code).toBe("42501");
    const live = await company("חיה");
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [person]));
    expect((await pgError(link(person, live))).code).toBe("42501");
  });

  it("the recycle bin keeps the links; purging a company or a contact takes its links along", async () => {
    const [a, b] = [await company("זטא"), await company("אטא")];
    const person = await contact("דנה", a);
    await link(person, b, "יועצת");
    // the company in the bin and back: the link is still there
    await asUser(owner.id, (q) => q("update public.companies set deleted_at = now() where id = $1", [b]));
    await asUser(owner.id, (q) => q("update public.companies set deleted_at = null where id = $1", [b]));
    expect(await links(person)).toHaveLength(2);
    // purging the primary company clears the contact's company and its link; the other stays
    await asUser(owner.id, async (q) => {
      await q("update public.companies set deleted_at = now() where id = $1", [a]);
      await q("delete from public.companies where id = $1", [a]);
    });
    expect(await links(person)).toEqual([{ company_id: b, title: "יועצת", is_primary: false }]);
    expect(await asAdmin(async (q) => (await q<{ c: string | null }>("select company_id as c from public.contacts where id = $1", [person])).rows[0].c)).toBeNull();
    // purging the contact takes the rest
    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [person]);
      await q("delete from public.contacts where id = $1", [person]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_companies where contact_id = $1", [person]))).toBe(0);
  });

  it("a further company and its role are in the contact's history; the primary mark is not; a privacy erasure covers them", async () => {
    const [a, b] = [await company("כנרת"), await company("למד")];
    const person = await contact("אורית כץ", a);
    const entries = () =>
      asAdmin(async (q) =>
        (await q<{ c: Record<string, { old: string | null; new: string | null }> }>(
          "select changes as c from public.audit_log where entity_type = 'contacts' and entity_id = $1 and changes ? 'company_link' order by created_at, id",
          [person],
        )).rows.map((r) => r.c.company_link),
      );
    expect(await entries()).toEqual([]);
    await link(person, b, "מנהלת רכש");
    await asUser(owner.id, (q) => q("update public.contact_companies set title = 'סמנכ\"לית' where contact_id = $1 and company_id = $2", [person, b]));
    await setCompany(person, b);
    await asUser(owner.id, (q) => q("delete from public.contact_companies where contact_id = $1 and company_id = $2", [person, a]));
    expect(await entries()).toEqual([
      { old: null, new: "למד (מנהלת רכש)" },
      { old: "למד (מנהלת רכש)", new: 'למד (סמנכ"לית)' },
      { old: "כנרת", new: null },
    ]);

    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [person]);
      await q("delete from public.contacts where id = $1", [person]);
      await q("select public.audit_erase_record($1, 'contacts', $2)", [org, person]);
    });
    const left = await asAdmin(async (q) => (await q<{ t: string }>("select string_agg(changes::text, ' ') as t from public.audit_log where entity_id = $1", [person])).rows[0].t);
    expect(left).not.toContain("מנהלת רכש");
    expect(left).not.toContain("סמנכ");
  });

  it("a contact merge keeps the duplicate's companies on the kept contact; a company merge keeps the duplicate company's people", async () => {
    const [a, b, c] = [await company("מם"), await company("נון"), await company("סמך")];
    const keep = await contact("יעל", a);
    const dup = await contact("יעל ב", b);
    await link(keep, c);
    await link(dup, c, "מייסדת");
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
    expect(await links(keep)).toEqual([
      { company_id: a, title: null, is_primary: true },
      { company_id: b, title: null, is_primary: false },
      { company_id: c, title: "מייסדת", is_primary: false },
    ]);

    const [keepCo, dupCo] = [await company("עין"), await company("עין בע\"מ")];
    const worker = await contact("אבי", dupCo);
    const adviser = await contact("רינה");
    await link(adviser, dupCo, "רואת חשבון");
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'company', $2, $3, '{}')", [org, keepCo, dupCo]));
    expect(await links(worker)).toEqual([{ company_id: keepCo, title: null, is_primary: true }]);
    expect(await links(adviser)).toEqual([{ company_id: keepCo, title: "רואת חשבון", is_primary: false }]);
  });

  it("sample data gets primary links and still goes away whole", async () => {
    const boss = await createUser("cc-sample");
    const sampleOrg = await createOrg(boss.id, "עסק לדוגמה עם חברות");
    await asUser(boss.id, (q) => q("select public.sample_data_add($1)", [sampleOrg]));
    const [withCompany, primaryLinks] = await asAdmin(async (q) => [
      await count(q, "select 1 from public.contacts where organization_id = $1 and company_id is not null", [sampleOrg]),
      await count(q, "select 1 from public.contact_companies where organization_id = $1 and is_primary", [sampleOrg]),
    ]);
    expect(primaryLinks).toBe(withCompany);
    await asUser(boss.id, (q) => q("select public.sample_data_remove($1)", [sampleOrg]));
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_companies where organization_id = $1", [sampleOrg]))).toBe(0);
  });

  it("a link a person made keeps a sample contact and a sample company; the sample's own primary links do not", async () => {
    const boss = await createUser("cc-sample-keep");
    const sampleOrg = await createOrg(boss.id, "עסק דוגמה עם קשר אמיתי");
    await asUser(boss.id, (q) => q("select public.sample_data_add($1)", [sampleOrg]));
    type R = { record_type: string; record_id: string; removable: boolean };
    const records = () => asUser(boss.id, async (q) => (await q<R>("select * from public.sample_data_records($1)", [sampleOrg])).rows);
    const removable = async () => new Map((await records()).map((r) => [r.record_id, r.removable]));
    expect((await records()).every((r) => r.removable)).toBe(true);

    // the sample contact without a company first: linking it must not touch the sample company (the order of
    // sample records is not fixed; they are made in one transaction)
    const sampleContacts = await asAdmin(async (q) =>
      (await q<{ id: string }>(
        "select c.id from public.contacts c where c.id = any ($1) order by (c.company_id is not null), c.id",
        [(await records()).filter((r) => r.record_type === "contact").map((r) => r.record_id)],
      )).rows.map((r) => r.id),
    );
    const sampleCompany = (await records()).find((r) => r.record_type === "company")!.record_id;
    // a real company linked to a sample contact as a further company keeps that contact
    const [real, realPerson] = await asUser(boss.id, async (q) => [
      (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברה אמיתית') returning id", [sampleOrg])).rows[0].id,
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'לקוחה אמיתית') returning id", [sampleOrg])).rows[0].id,
    ]);
    await asUser(boss.id, (q) => q("insert into public.contact_companies (organization_id, contact_id, company_id) values ($1, $2, $3)", [sampleOrg, sampleContacts[0], real]));
    expect((await removable()).get(sampleContacts[0])).toBe(false);
    // a real person linked to the sample company keeps the company
    expect((await removable()).get(sampleCompany)).toBe(true);
    await asUser(boss.id, (q) => q("insert into public.contact_companies (organization_id, contact_id, company_id) values ($1, $2, $3)", [sampleOrg, realPerson, sampleCompany]));
    expect((await removable()).get(sampleCompany)).toBe(false);
    // a role set on a sample contact's primary link keeps it too
    const withCompany = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.contacts where id = any ($1) and company_id is not null and id <> $2 limit 1", [sampleContacts, sampleContacts[0]])).rows[0]?.id,
    );
    expect(withCompany).toBeTruthy();
    expect((await removable()).get(withCompany)).toBe(true);
    await asUser(boss.id, (q) => q("update public.contact_companies set title = 'מנהלת' where contact_id = $1 and is_primary", [withCompany]));
    expect((await removable()).get(withCompany)).toBe(false);
    // removal keeps them and the real links
    await asUser(boss.id, (q) => q("select public.sample_data_remove($1)", [sampleOrg]));
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_companies where organization_id = $1 and (company_id = $2 or contact_id = $3)", [sampleOrg, real, realPerson]))).toBe(2);
  });

  it("undo of one's own import keeps a contact or a company someone linked after the import (PRM-01)", async () => {
    const boss = await createUser("cc-import-owner");
    const importOrg = await createOrg(boss.id, "עסק ייבוא");
    const holder = await addMember(importOrg, boss.id, "member", "cc-import-holder");
    await asUser(boss.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [importOrg, holder.id, ["import"]]));
    const job = await asUser(holder.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'c.csv', 'skip') returning id", [importOrg])).rows[0].id,
    );
    // one chunk: two companies and three contacts, each with its imported company (primary links made then)
    const made = await asUser(holder.id, async (q) => {
      const co = async (name: string) => (await q<{ id: string }>("insert into public.companies (organization_id, name, import_job_id) values ($1, $2, $3) returning id", [importOrg, name, job])).rows[0].id;
      const [linked, plain] = [await co("קושרה אחרי"), await co("לא נגעו")];
      const person = async (name: string, company: string) =>
        (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, company_id, import_job_id) values ($1, $2, $3, $4) returning id", [importOrg, name, company, job])).rows[0].id;
      const [linker, retitled, untouched] = [await person("מקשרת", plain), await person("עם תפקיד", plain), await person("שקטה", plain)];
      await q("update public.import_jobs set status = 'done' where id = $1", [job]);
      return { linked, plain, linker, retitled, untouched };
    });
    // later, in other transactions: a real contact linked to one imported company; a link added to one imported
    // contact; a role set on another one's primary link
    const outsider = await asUser(boss.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'מבחוץ') returning id", [importOrg])).rows[0].id);
    await asUser(boss.id, async (q) => {
      await q("insert into public.contact_companies (organization_id, contact_id, company_id, title) values ($1, $2, $3, 'יועצת')", [importOrg, outsider, made.linked]);
      await q("insert into public.contact_companies (organization_id, contact_id, company_id) values ($1, $2, $3)", [importOrg, made.linker, made.linked]);
      await q("update public.contact_companies set title = 'מנהלת' where contact_id = $1 and is_primary", [made.retitled]);
    });
    const result = await asUser(holder.id, async (q) => (await q<{ r: { done: number; kept: number } }>("select public.undo_own_import($1, $2) as r", [importOrg, job])).rows[0].r);
    const binned = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.contacts where id = any ($1) and deleted_at is not null union all select id from public.companies where id = any ($2) and deleted_at is not null", [
        [made.linker, made.retitled, made.untouched],
        [made.linked, made.plain],
      ])).rows.map((r) => r.id),
    );
    expect(binned).toEqual([made.untouched]);
    expect(result).toEqual({ done: 1, kept: 4 });
  });

  it("an UPDATE or DELETE with no WHERE never reaches a link to a company the person cannot read (review, 15 October)", async () => {
    const boss = await createUser("cc-hidden-owner");
    const hiddenOrg = await createOrg(boss.id, "עסק חברה מוסתרת");
    const seller = await addMember(hiddenOrg, boss.id, "member", "cc-hidden-rep");
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [hiddenOrg]));
    const [theirs, mineCo] = [await company("של הבעלים", hiddenOrg, boss), await company("של הנציג", hiddenOrg, seller)];
    const person = await asUser(seller.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'לקוח של הנציג') returning id", [hiddenOrg])).rows[0].id);
    // the owner links the seller's contact to a company only the owner reads; the seller links their own
    await asUser(boss.id, (q) => q("insert into public.contact_companies (organization_id, contact_id, company_id, title) values ($1, $2, $3, 'סמוי')", [hiddenOrg, person, theirs]));
    await asUser(seller.id, (q) => q("insert into public.contact_companies (organization_id, contact_id, company_id) values ($1, $2, $3)", [hiddenOrg, person, mineCo]));
    expect((await asUser(seller.id, (q) => q("update public.contact_companies set title = 'נדרס'"))).rowCount).toBe(1);
    expect((await asUser(seller.id, (q) => q("delete from public.contact_companies"))).rowCount).toBe(1);
    const left = await asAdmin(async (q) => (await q<{ company_id: string; title: string | null }>("select company_id, title from public.contact_companies where contact_id = $1", [person])).rows);
    expect(left).toEqual([{ company_id: theirs, title: "סמוי" }]);
  });

  it("the 50-link cap counts links to companies the person cannot read too (review, 15 October)", async () => {
    const boss = await createUser("cc-cap-owner");
    const capOrg = await createOrg(boss.id, "עסק מכסת קישורים");
    const seller = await addMember(capOrg, boss.id, "member", "cc-cap-rep");
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [capOrg]));
    const person = await asUser(seller.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'רב קשרים') returning id", [capOrg])).rows[0].id);
    // 50 links to the owner's companies, which the seller does not read
    await asAdmin((q) =>
      q(
        `with made as (insert into public.companies (organization_id, name, owner_id) select $1, 'חברה ' || n, $3 from generate_series(1, 50) n returning id)
         insert into public.contact_companies (organization_id, contact_id, company_id) select $1, $2, id from made`,
        [capOrg, person, boss.id],
      ),
    );
    expect(await asUser(seller.id, (q) => count(q, "select 1 from public.contact_companies where contact_id = $1", [person]))).toBe(0);
    const own = await company("שלי", capOrg, seller);
    expect((await pgError(asUser(seller.id, (q) => q("insert into public.contact_companies (organization_id, contact_id, company_id) values ($1, $2, $3)", [capOrg, person, own])))).hint).toBe(
      "contact_company:max",
    );
  });

  it("undo of one's own import takes the import's company along when its contact came in a later chunk (review, 15 October)", async () => {
    const boss = await createUser("cc-chunks-owner");
    const chunkOrg = await createOrg(boss.id, "עסק ייבוא בחלקים");
    const holder = await addMember(chunkOrg, boss.id, "member", "cc-chunks-holder");
    await asUser(boss.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [chunkOrg, holder.id, ["import"]]));
    const job = await asUser(holder.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'c.csv', 'skip') returning id", [chunkOrg])).rows[0].id,
    );
    // chunk 1: the company; chunk 2, a later transaction: its contact (the primary link is newer than the company)
    const co = await asUser(holder.id, async (q) =>
      (await q<{ id: string }>("insert into public.companies (organization_id, name, import_job_id) values ($1, 'חברה מיובאת', $2) returning id", [chunkOrg, job])).rows[0].id,
    );
    const person = await asUser(holder.id, async (q) => {
      const id = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, company_id, import_job_id) values ($1, 'איש מיובא', $2, $3) returning id", [chunkOrg, co, job])).rows[0].id;
      await q("update public.import_jobs set status = 'done' where id = $1", [job]);
      return id;
    });
    const result = await asUser(holder.id, async (q) => (await q<{ r: { done: number; kept: number } }>("select public.undo_own_import($1, $2) as r", [chunkOrg, job])).rows[0].r);
    expect(result).toEqual({ done: 2, kept: 0 });
    expect(await asAdmin((q) => count(q, "select 1 from public.companies where id = $1 and deleted_at is not null", [co]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1 and deleted_at is not null", [person]))).toBe(1);
  });

  it("a member links only contacts they edit (rights follow the contact)", async () => {
    const a = await company("פא", org, rep);
    const theirs = await contact("של הבעלים");
    expect((await pgError(link(theirs, a, null, rep))).code).toBe("42501");
    const mine = await contact("של הנציג", null, rep);
    expect(await link(mine, a, "קניין", rep)).toBeTruthy();
  });

  it("the migration fills one primary link per contact with a company, and is safe to run again", async () => {
    const a = await company("צדי");
    const person = await contact("גלית", a);
    // as before the migration: no link rows for this contact
    await asAdmin((q) => q("delete from public.contact_companies where contact_id = $1", [person]));
    const rerun = rerunClosure([migrationFile("_contact_companies.sql")]);
    expect(rerun.files[0]).toMatch(/_contact_companies\.sql$/);
    await asAdmin(async (q) => {
      for (const sql of rerun.sql) await q(sql);
      for (const sql of rerun.sql) await q(sql);
    });
    expect(await links(person)).toEqual([{ company_id: a, title: null, is_primary: true }]);
    // every contact with a company has exactly one primary link to it, and no contact has two
    const [missing, extra] = await asAdmin(async (q) => [
      await count(q, "select 1 from public.contacts c where c.company_id is not null and not exists (select 1 from public.contact_companies cc where cc.organization_id = c.organization_id and cc.contact_id = c.id and cc.company_id = c.company_id and cc.is_primary)"),
      await count(q, "select 1 from public.contact_companies cc join public.contacts c on c.organization_id = cc.organization_id and c.id = cc.contact_id where cc.is_primary and cc.company_id is distinct from c.company_id"),
    ]);
    expect([missing, extra]).toEqual([0, 0]);
    // the migration's own text holds no drop statement, no row removal and no \u escape
    const text = readFileSync(join(MIGRATIONS_DIR, migrationFile("_contact_companies.sql")), "utf8");
    expect(text).not.toMatch(/^\s*drop\s/im);
    expect(text).not.toMatch(/delete\s+from/i);
    expect(text).not.toMatch(/\\u[0-9a-f]{4}/i);
  });
});
