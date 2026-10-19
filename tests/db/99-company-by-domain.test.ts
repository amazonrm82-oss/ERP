import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CANDIDATE_CASES, EMAIL_CASES, REGISTERED_CASES, WEBSITE_CASES } from "../unit/fixtures/company-domain-cases";
import { addMember, asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(async () => {
  await closePool();
});

type U = { id: string };
type Linked = { company_id: string | null; company_matched_domain: string | null; company_match_kind?: string | null };

// CON-09: trigger contacts_company_by_domain links a person's new contact to the one company they
// read (not in the bin) whose website or email has the contact's email domain; never for a public
// mail provider, never over a picked company, never for server writers or an import that mapped a
// company column. public.company_domain_matches() feeds it and the contact card.
describe("company by email domain (CON-09)", () => {
  let owner: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let n = 0;

  const newCompany = (userId: string, fields: { name?: string; website?: string | null; email?: string | null }, orgId = org) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>("insert into public.companies (organization_id, name, website, email) values ($1, $2, $3, $4) returning id", [
          orgId,
          fields.name ?? `חברה ${++n}`,
          fields.website ?? null,
          fields.email ?? null,
        ])
      ).rows[0].id,
    );
  const newContact = (userId: string, email: string | null, extra: { company_id?: string | null; import_job_id?: string } = {}, orgId = org) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string } & Linked>(
          `insert into public.contacts (organization_id, first_name, email, company_id, import_job_id)
           values ($1, 'דנה', $2, $3, $4) returning id, company_id, company_matched_domain, company_match_kind`,
          [orgId, email, extra.company_id ?? null, extra.import_job_id ?? null],
        )
      ).rows[0],
    );
  // a domain of its own for each test, so companies of earlier tests do not match
  const domain = () => `d${++n}-${Date.now().toString(36)}.co.il`;

  beforeAll(async () => {
    owner = await createUser("dom-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "dom-member");
    outsider = await createUser("dom-outsider");
    otherOrg = await createOrg(outsider.id);
  });

  it("parses emails and websites like the TS mirror", async () => {
    await asAdmin(async (q) => {
      for (const [input, expected] of EMAIL_CASES) {
        expect((await q<{ d: string | null }>("select app.email_domain($1) as d", [input])).rows[0].d, input).toBe(expected);
      }
      for (const [input, expected] of WEBSITE_CASES) {
        expect((await q<{ d: string | null }>("select app.website_domain($1) as d", [input])).rows[0].d, input).toBe(expected);
      }
      for (const [input, expected] of REGISTERED_CASES) {
        expect((await q<{ d: string | null }>("select app.registered_domain($1) as d", [input])).rows[0].d, input).toBe(expected);
      }
      for (const [input, expected] of CANDIDATE_CASES) {
        expect((await q<{ d: string[] }>("select app.domain_candidates($1) as d", [input])).rows[0].d, input).toEqual(expected);
      }
    });
  });

  it("links to the one company with the domain, by website or by email", async () => {
    const d1 = domain();
    const bySite = await newCompany(owner.id, { website: `https://www.${d1}/about` });
    const first = await newContact(member.id, `Dana@${d1.toUpperCase()}`);
    expect(first.company_id).toBe(bySite);
    expect(first.company_matched_domain).toBe(d1);
    expect(first.company_match_kind).toBe("exact");

    const d2 = domain();
    const byEmail = await newCompany(owner.id, { email: `info@${d2}` });
    const second = await newContact(member.id, `yossi@${d2}`);
    expect(second.company_id).toBe(byEmail);
  });

  it("links nothing without a match, and nothing for a contact without an email", async () => {
    await newCompany(owner.id, { website: domain() });
    expect((await newContact(member.id, `x@${domain()}`)).company_id).toBeNull();
    const nobody = await asUser(member.id, async (q) =>
      (await q<Linked>("insert into public.contacts (organization_id, first_name) values ($1, 'בלי אימייל') returning company_id, company_matched_domain", [org])).rows[0],
    );
    expect(nobody.company_id).toBeNull();
  });

  it("links nothing when two companies share the domain, and offers both", async () => {
    const d = domain();
    const a = await newCompany(owner.id, { name: "אלפא", website: d });
    const b = await newCompany(owner.id, { name: "בטא", email: `office@${d}` });
    const contact = await newContact(member.id, `x@${d}`);
    expect(contact.company_id).toBeNull();
    expect(contact.company_matched_domain).toBeNull();
    const offered = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("select id from public.company_domain_matches($1, $2)", [org, `x@${d}`])).rows.map((r) => r.id),
    );
    expect(offered).toEqual([a, b]);
  });

  it("never links by a public mail provider", async () => {
    await newCompany(owner.id, { website: "gmail.com", email: "boss@gmail.com" });
    await newCompany(owner.id, { email: "office@walla.co.il" });
    expect((await newContact(member.id, "dana@gmail.com")).company_id).toBeNull();
    expect((await newContact(member.id, "dana@walla.co.il")).company_id).toBeNull();
    expect(
      await asUser(member.id, async (q) => (await q("select * from public.company_domain_matches($1, 'dana@gmail.com')", [org])).rowCount),
    ).toBe(0);
  });

  it("skips a company in the recycle bin", async () => {
    const d = domain();
    const binned = await newCompany(owner.id, { website: d });
    await asUser(owner.id, (q) => q("update public.companies set deleted_at = now() where id = $1", [binned]));
    expect((await newContact(member.id, `x@${d}`)).company_id).toBeNull();
    // a binned one does not count as a second match either
    const live = await newCompany(owner.id, { website: d });
    expect((await newContact(member.id, `y@${d}`)).company_id).toBe(live);
  });

  it("skips a company the person may not read", async () => {
    const d = domain();
    const hidden = await newCompany(owner.id, { website: d });
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect((await newContact(member.id, `x@${d}`)).company_id).toBeNull();
      // and a hidden one does not block the one the member reads
      const mine = await newCompany(member.id, { email: `info@${d}` });
      expect((await newContact(member.id, `y@${d}`)).company_id).toBe(mine);
      // the owner reads both: two matches, no link
      expect((await newContact(owner.id, `z@${d}`)).company_id).toBeNull();
      expect(hidden).toBeTruthy();
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a member with 'own' visibility still finds their company among many hidden ones", async () => {
    const d = domain();
    await asAdmin(async (q) => {
      await q(
        `insert into public.companies (organization_id, name, website, email, owner_id)
         select $1, 'מוסתרת ' || g, $2, 'office@' || $2, $3 from generate_series(1, 60) g`,
        [org, d, owner.id],
      );
    });
    const mine = await newCompany(member.id, { name: "של החבר", website: d });
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const rows = await asUser(member.id, async (q) =>
        (await q<{ id: string }>("select id from public.company_domain_matches($1, $2)", [org, `x@${d}`])).rows.map((r) => r.id),
      );
      expect(rows).toEqual([mine]);
      expect((await newContact(member.id, `y@${d}`)).company_id).toBe(mine);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("returns up to 7 companies of one tier, so the card can tell 6 from more", async () => {
    const d = domain();
    for (let i = 0; i < 6; i++) await newCompany(owner.id, { name: `שש ${i}`, website: d });
    const six = await asUser(member.id, async (q) => (await q("select * from public.company_domain_matches($1, $2)", [org, `x@${d}`])).rowCount);
    expect(six).toBe(6);
    for (let i = 0; i < 3; i++) await newCompany(owner.id, { name: `עוד ${i}`, email: `office@${d}` });
    const more = await asUser(member.id, async (q) => (await q("select * from public.company_domain_matches($1, $2)", [org, `x@${d}`])).rowCount);
    expect(more).toBe(7);
    // still no link
    expect((await newContact(member.id, `y@${d}`)).company_id).toBeNull();
  });

  it("keeps a company the person picked", async () => {
    const d = domain();
    await newCompany(owner.id, { website: d });
    const picked = await newCompany(owner.id, { name: "בחרו בה" });
    const contact = await newContact(member.id, `x@${d}`, { company_id: picked });
    expect(contact.company_id).toBe(picked);
    expect(contact.company_matched_domain).toBeNull();
  });

  it("never changes existing contacts, and any company change clears the mark", async () => {
    const d = domain();
    const before = await newContact(member.id, `x@${d}`);
    const company = await newCompany(owner.id, { website: d });
    // an update of the existing contact does not link it
    await asUser(member.id, (q) => q("update public.contacts set email = $2, first_name = 'דנה ב' where id = $1", [before.id, `y@${d}`]));
    const still = await asAdmin(async (q) => (await q<Linked>("select company_id, company_matched_domain from public.contacts where id = $1", [before.id])).rows[0]);
    expect(still.company_id).toBeNull();

    const linked = await newContact(member.id, `z@${d}`);
    expect(linked.company_id).toBe(company);
    // removing the link is a normal update; the domain mark goes with it
    await asUser(member.id, (q) => q("update public.contacts set company_id = null where id = $1", [linked.id]));
    const after = await asAdmin(async (q) => (await q<Linked>("select company_id, company_matched_domain, company_match_kind from public.contacts where id = $1", [linked.id])).rows[0]);
    expect(after).toEqual({ company_id: null, company_matched_domain: null, company_match_kind: null });
    // the audit log recorded the link with the insert and its removal
    const audit = await asAdmin(async (q) =>
      (await q<{ action: string }>("select action from public.audit_log where entity_id = $1 order by created_at", [linked.id])).rows.map((r) => r.action),
    );
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("a person cannot write the mark", async () => {
    const e = await pgError(
      asUser(member.id, (q) => q("insert into public.contacts (organization_id, first_name, company_matched_domain) values ($1, 'x', 'acme.co.il')", [org])),
    );
    expect(e.code).toBe("42501");
  });

  it("imports link only when the file did not map a company column", async () => {
    const d = domain();
    const company = await newCompany(owner.id, { website: d });
    const job = (mapsCompany: boolean) =>
      asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows, maps_company) values ($1, 'contact', 'a.csv', 'create', 1, $2) returning id",
            [org, mapsCompany],
          )
        ).rows[0].id,
      );
    const unmapped = await job(false);
    expect((await newContact(owner.id, `a@${d}`, { import_job_id: unmapped })).company_id).toBe(company);
    const mapped = await job(true);
    expect((await newContact(owner.id, `b@${d}`, { import_job_id: mapped })).company_id).toBeNull();
  });

  it("server writers are left alone: conversion keeps its own company logic", async () => {
    const d = domain();
    await newCompany(owner.id, { website: d });
    const server = await asAdmin(async (q) =>
      (await q<Linked>("insert into public.contacts (organization_id, first_name, email) values ($1, 'שרת', $2) returning company_id, company_matched_domain", [org, `s@${d}`]))
        .rows[0],
    );
    expect(server.company_id).toBeNull();

    const leadId = await insertLead(member.id, org, { full_name: "ליד בלי חברה", email: `lead@${d}` });
    const result = await asUser(member.id, async (q) =>
      (await q<{ r: { contact_id: string; company_id: string | null } }>("select public.convert_lead($1) as r", [leadId])).rows[0].r,
    );
    expect(result.company_id).toBeNull();
    const contact = await asAdmin(async (q) => (await q<Linked>("select company_id, company_matched_domain from public.contacts where id = $1", [result.contact_id])).rows[0]);
    expect(contact).toEqual({ company_id: null, company_matched_domain: null });
  });

  it("an outsider's contact never links into another organization, and they see no matches there", async () => {
    const d = domain();
    await newCompany(owner.id, { website: d });
    expect((await newContact(outsider.id, `x@${d}`, {}, otherOrg)).company_id).toBeNull();
    expect(
      await asUser(outsider.id, async (q) => (await q("select * from public.company_domain_matches($1, $2)", [org, `x@${d}`])).rowCount),
    ).toBe(0);
    const e = await pgError(newContact(outsider.id, `y@${d}`, {}, org));
    expect(e.code).toBe("42501");
  });

  describe("a domain from the company's contacts (owner, 14 October 2026)", () => {
    // contacts linked to the company by hand, so the trigger does not decide for them
    const seed = async (userId: string, company: string, emails: string[]) => {
      const ids: string[] = [];
      for (const email of emails) ids.push((await newContact(userId, email, { company_id: company })).id);
      return ids;
    };
    const derived = (userId: string, company: string) =>
      asUser(userId, async (q) => (await q<{ d: string | null }>("select public.company_contact_domain($1, $2) as d", [org, company])).rows[0].d);

    it("two contacts sharing a domain give a match, one contact does not", async () => {
      const d = domain();
      const company = await newCompany(owner.id, { name: "בלי אתר" });
      await seed(owner.id, company, [`a@${d}`]);
      expect(await derived(member.id, company)).toBeNull();
      expect((await newContact(member.id, `x@${d}`)).company_id).toBeNull();
      await seed(owner.id, company, [`b@${d}`]);
      expect(await derived(member.id, company)).toBe(d);
      const linked = await newContact(member.id, `y@${d}`);
      expect(linked.company_id).toBe(company);
      expect(linked.company_matched_domain).toBe(d);
      expect(linked.company_match_kind).toBe("contacts");
    });

    it("the company's own website or email always wins", async () => {
      const own = domain();
      const other = domain();
      const company = await newCompany(owner.id, { website: `https://${own}` });
      await seed(owner.id, company, [`a@${other}`, `b@${other}`]);
      expect((await newContact(member.id, `x@${other}`)).company_id).toBeNull();
      expect((await newContact(member.id, `x@${own}`)).company_id).toBe(company);
      // a public company email is no own domain: the contacts' domain counts
      const d = domain();
      const publicMail = await newCompany(owner.id, { email: "boss@gmail.com" });
      await seed(owner.id, publicMail, [`a@${d}`, `b@${d}`]);
      expect((await newContact(member.id, `x@${d}`)).company_id).toBe(publicMail);
    });

    it("own beats contact-derived at the same domain (owner's order)", async () => {
      const d = domain();
      const own = await newCompany(owner.id, { website: d });
      const derivedOnly = await newCompany(owner.id, {});
      await seed(owner.id, derivedOnly, [`a@${d}`, `b@${d}`]);
      expect(await newContact(member.id, `x@${d}`)).toMatchObject({ company_id: own, company_match_kind: "exact" });
    });

    it("contact-derived beats a parent by subdomain", async () => {
      const d = domain();
      await newCompany(owner.id, { website: d });
      const sales = await newCompany(owner.id, {});
      await seed(owner.id, sales, [`a@sales.${d}`, `b@sales.${d}`]);
      expect(await newContact(member.id, `x@sales.${d}`)).toMatchObject({
        company_id: sales,
        company_matched_domain: `sales.${d}`,
        company_match_kind: "contacts",
      });
    });

    it("two contact-derived matches give the choice, not a link", async () => {
      const d = domain();
      const a = await newCompany(owner.id, { name: "גזורה א" });
      const b = await newCompany(owner.id, { name: "גזורה ב" });
      await seed(owner.id, a, [`a@${d}`, `b@${d}`]);
      await seed(owner.id, b, [`c@${d}`, `d@${d}`]);
      expect((await newContact(member.id, `x@${d}`)).company_id).toBeNull();
      const rows = await asUser(member.id, async (q) =>
        (await q<{ id: string; kind: string }>("select id, kind from public.company_domain_matches($1, $2)", [org, `x@${d}`])).rows,
      );
      expect(rows).toEqual([
        { id: a, kind: "contacts" },
        { id: b, kind: "contacts" },
      ]);
    });

    it("the flag turns the derived domain off, and clearing it turns it back on", async () => {
      const d = domain();
      const company = await newCompany(member.id, {});
      await seed(member.id, company, [`a@${d}`, `b@${d}`]);
      await asUser(member.id, (q) => q("update public.companies set contact_domain_off = true where id = $1", [company]));
      expect((await newContact(member.id, `x@${d}`)).company_id).toBeNull();
      // the card still knows the domain, to offer turning it back on
      expect(await derived(member.id, company)).toBe(d);
      await asUser(member.id, (q) => q("update public.companies set contact_domain_off = null where id = $1", [company]));
      expect((await newContact(member.id, `y@${d}`)).company_id).toBe(company);
      // false is not a value: off is true, on is null
      const e = await pgError(asUser(member.id, (q) => q("update public.companies set contact_domain_off = false where id = $1", [company])));
      expect(e.code).toBe("23514");
      // audited like any company column
      expect(
        await asAdmin(async (q) =>
          (await q("select 1 from public.audit_log where entity_id = $1 and changes ? 'contact_domain_off'", [company])).rowCount,
        ),
      ).toBeGreaterThanOrEqual(2);
    });

    it("a public domain is never derived", async () => {
      const company = await newCompany(owner.id, {});
      await seed(owner.id, company, ["a@gmail.com", "b@gmail.com", "c@nana10.co.il", "d@nana10.co.il"]);
      expect(await derived(owner.id, company)).toBeNull();
      expect((await newContact(owner.id, "x@nana10.co.il")).company_id).toBeNull();
    });

    it("a binned contact does not count", async () => {
      const d = domain();
      const company = await newCompany(owner.id, {});
      const [first] = await seed(owner.id, company, [`a@${d}`, `b@${d}`]);
      await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [first]));
      expect(await derived(owner.id, company)).toBeNull();
      expect((await newContact(owner.id, `x@${d}`)).company_id).toBeNull();
    });

    it("two domains that each reach two contacts give none", async () => {
      const d1 = domain();
      const d2 = domain();
      const company = await newCompany(owner.id, {});
      await seed(owner.id, company, [`a@${d1}`, `b@${d1}`, `a@${d2}`, `b@${d2}`]);
      expect(await derived(owner.id, company)).toBeNull();
      expect((await newContact(owner.id, `x@${d1}`)).company_id).toBeNull();
    });

    it("counts only contacts and companies the caller reads", async () => {
      const d = domain();
      const hiddenCompany = await newCompany(owner.id, {});
      await seed(owner.id, hiddenCompany, [`a@${d}`, `b@${d}`]);
      const e2 = domain();
      const membersCompany = await newCompany(member.id, {});
      // the owner's contacts on the member's company
      await seed(owner.id, membersCompany, [`a@${e2}`, `b@${e2}`]);
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
      try {
        // a company the member cannot read is no match
        expect((await newContact(member.id, `x@${d}`)).company_id).toBeNull();
        // contacts the member cannot read give their company no domain for the member
        expect(await derived(member.id, membersCompany)).toBeNull();
        expect((await newContact(member.id, `x@${e2}`)).company_id).toBeNull();
        // the owner reads them all
        expect(await derived(owner.id, membersCompany)).toBe(e2);
      } finally {
        await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
      }
      // an outsider learns nothing about another organization
      expect(
        await asUser(outsider.id, async (q) => (await q<{ d: string | null }>("select public.company_contact_domain($1, $2) as d", [org, membersCompany])).rows[0].d),
      ).toBeNull();
      expect(
        await asUser(outsider.id, async (q) => (await q("select * from public.company_domain_matches($1, $2)", [org, `x@${e2}`])).rowCount),
      ).toBe(0);
    });

    it("a viewer cannot switch the domain off", async () => {
      const viewer = await addMember(org, owner.id, "viewer", "dom-viewer");
      const company = await newCompany(owner.id, {});
      const res = await asUser(viewer.id, (q) => q("update public.companies set contact_domain_off = true where id = $1", [company]).catch((e) => e));
      const off = await asAdmin(async (q) => (await q<{ o: boolean | null }>("select contact_domain_off as o from public.companies where id = $1", [company])).rows[0].o);
      expect(off).toBeNull();
      expect(res).toBeTruthy();
    });
  });

  describe("subdomains (owner, 14 October 2026)", () => {
    // a registered domain of its own for each test
    const base = () => `acme${++n}-${Date.now().toString(36)}`;

    it("the full domain wins over its parent", async () => {
      const b = `${base()}.co.il`;
      const sales = await newCompany(owner.id, { website: `sales.${b}` });
      const parent = await newCompany(owner.id, { website: b });
      const exact = await newContact(member.id, `x@sales.${b}`);
      expect(exact).toMatchObject({ company_id: sales, company_matched_domain: `sales.${b}`, company_match_kind: "exact" });
      // one level more: the nearest parent that has a company
      const deeper = await newContact(member.id, `x@eu.sales.${b}`);
      expect(deeper).toMatchObject({ company_id: sales, company_matched_domain: `sales.${b}`, company_match_kind: "parent" });
      const other = await newContact(member.id, `x@support.${b}`);
      expect(other).toMatchObject({ company_id: parent, company_matched_domain: b, company_match_kind: "parent" });
    });

    it("sales.acme.co.il goes to acme.co.il", async () => {
      const b = `${base()}.co.il`;
      const company = await newCompany(owner.id, { email: `info@${b}` });
      expect(await newContact(member.id, `dana@sales.${b}`)).toMatchObject({ company_id: company, company_matched_domain: b, company_match_kind: "parent" });
    });

    it("a.b.c.acme.com goes to acme.com", async () => {
      const b = `${base()}.com`;
      const company = await newCompany(owner.id, { website: `https://www.${b}` });
      expect(await newContact(member.id, `dana@a.b.c.${b}`)).toMatchObject({ company_id: company, company_matched_domain: b, company_match_kind: "parent" });
    });

    it("never stops at co.il, com or another suffix", async () => {
      await newCompany(owner.id, { website: "co.il" });
      await newCompany(owner.id, { website: "https://com" });
      await newCompany(owner.id, { email: "x@org.il" });
      expect((await newContact(member.id, `dana@${base()}.co.il`)).company_id).toBeNull();
      expect((await newContact(member.id, `dana@${base()}.org.il`)).company_id).toBeNull();
    });

    it("a site host is public at every level: x.wixsite.com never matches", async () => {
      const b = base();
      await newCompany(owner.id, { website: `https://${b}.wixsite.com/shop` });
      await newCompany(owner.id, { website: "wixsite.com" });
      expect((await newContact(member.id, `dana@${b}.wixsite.com`)).company_id).toBeNull();
      // and such a website is no own domain: the company's contacts may give it one
      const d = `${base()}.co.il`;
      const company = await newCompany(owner.id, { website: `${base()}.myshopify.com` });
      await newContact(owner.id, `a@${d}`, { company_id: company });
      await newContact(owner.id, `b@${d}`, { company_id: company });
      expect(await newContact(member.id, `c@${d}`)).toMatchObject({ company_id: company, company_match_kind: "contacts" });
    });

    it("two companies on the nearest level give a choice, not a link", async () => {
      const b = `${base()}.com`;
      await newCompany(owner.id, { name: "א", website: b });
      await newCompany(owner.id, { name: "ב", email: `office@${b}` });
      expect((await newContact(member.id, `x@eu.${b}`)).company_id).toBeNull();
      const rows = await asUser(member.id, async (q) =>
        (await q<{ domain: string; kind: string }>("select domain, kind from public.company_domain_matches($1, $2)", [org, `x@eu.${b}`])).rows,
      );
      expect(rows).toEqual([
        { domain: b, kind: "parent" },
        { domain: b, kind: "parent" },
      ]);
    });
  });

  it("the lookup is for signed-in people only, not the service role", async () => {
    const e = await pgError(asService((q) => q("select * from public.company_domain_matches(gen_random_uuid(), 'a@b.co')")));
    expect(e.code).toBe("42501");
  });

  it("stays fast under RLS on 20,000 companies (indexes, not a scan)", async () => {
    const bigOwner = await createUser("dom-big");
    const big = await createOrg(bigOwner.id);
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(
        `insert into public.companies (organization_id, name, website, email)
         select $1, 'חברה ' || g, 'https://www.big' || g || '.co.il', 'office@big' || g || '.com' from generate_series(1, 20000) g`,
        [big],
      );
      await q("analyze public.companies");
    });
    const indexes = await asAdmin(async (q) =>
      (
        await q<{ indexname: string }>(
          "select indexname from pg_indexes where schemaname = 'public' and indexname in ('companies_website_domain_idx', 'companies_email_domain_idx', 'contacts_company_email_domain_idx')",
        )
      ).rows.length,
    );
    expect(indexes).toBe(3);
    // What the lookup does to the 20,000 rows, counted inside its own transaction (pg_stat_xact_user_tables), not timed: a wall
    // clock against a fixed limit failed by chance under the full suite's load (review of 19 October 2026). A scan with
    // app.can_read_record() per row (3.5 s here once) reads every company; the indexed lookup reads a handful.
    const { rows, reads } = await asUser(bigOwner.id, async (q) => {
      const found = (await q<{ id: string; kind: string }>("select id, kind from public.company_domain_matches($1, 'dana@sales.big12345.co.il')", [big])).rows;
      const counted = (
        await q<{ seq_scan: string; seq_tup_read: string; idx_scan: string; idx_tup_fetch: string }>(
          "select seq_scan, seq_tup_read, idx_scan, idx_tup_fetch from pg_stat_xact_user_tables where relid = 'public.companies'::regclass",
        )
      ).rows[0];
      return { rows: found, reads: counted };
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("parent");
    // a scan reads all 20,000 companies; the indexed lookup reads a handful (2 here)
    expect(Number(reads.seq_tup_read)).toBeLessThan(1000);
    expect(Number(reads.idx_tup_fetch)).toBeLessThan(1000);

    // The same among many small businesses, as in production and in the full suite: a business then looks like a few dozen
    // companies, and the plan once hashed the whole business (20,001 rows read, ~8 s) instead of probing the candidates
    // (020525). Seeded, analyzed and measured in one transaction that is rolled back, so nothing is left behind.
    class Measured extends Error {
      constructor(readonly value: { rows: number; seq: number; idx: number }) {
        super("rolled back on purpose");
      }
    }
    const crowded = await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(
        `insert into public.companies (organization_id, name, website, email)
         select md5('small-business-' || (g % 400))::uuid, 'קטנה ' || g, 'https://www.small' || g || '.co.il', 'a@small' || g || '.com'
           from generate_series(1, 4000) g`,
      );
      await q("set local session_replication_role = origin");
      await q("analyze public.companies");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: bigOwner.id, role: "authenticated" })]);
      await q("set local role authenticated");
      const stat = async () =>
        (await q<{ seq: string; idx: string }>(
          "select seq_tup_read as seq, idx_tup_fetch as idx from pg_stat_xact_user_tables where relid = 'public.companies'::regclass",
        )).rows[0];
      const before = await stat();
      const found = (await q("select id from public.company_domain_matches($1, 'dana@sales.big12345.co.il')", [big])).rows.length;
      const after = await stat();
      throw new Measured({ rows: found, seq: Number(after.seq) - Number(before.seq), idx: Number(after.idx) - Number(before.idx) });
    }).then(
      () => null,
      (e: unknown) => {
        if (e instanceof Measured) return e.value;
        throw e;
      },
    );
    expect(crowded).toMatchObject({ rows: 1 });
    expect(crowded!.seq).toBeLessThan(1000);
    expect(crowded!.idx).toBeLessThan(1000);
  });

  it("anon may not call the lookup", async () => {
    const e = await pgError(asAnon((q) => q("select * from public.company_domain_matches(gen_random_uuid(), 'a@b.co')")));
    expect(e.code).toBe("42501");
  });
});
