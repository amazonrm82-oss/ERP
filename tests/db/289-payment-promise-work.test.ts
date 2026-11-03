import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * RVW-64: a payment promise (COL-03) is work on a contact or company. An importer's undo (app.import_record_worked) keeps a
 * record someone promised to pay for, also when the promise is on the import's own opening balance; and removing sample data
 * (app.sample_untouched) keeps a sample contact or company with a promise on it.
 */
describe("a payment promise is work on its customer (RVW-64)", () => {
  let owner: U;
  let org: string;
  let n = 0;
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  // a calendar day of the business (Asia/Jerusalem)
  const day = (offset: number) =>
    new Date(Date.parse(`${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" })}T00:00:00Z`) + offset * 86_400_000)
      .toISOString()
      .slice(0, 10);

  const importJob = (entity: "contact" | "company") =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, $2, $3, 'skip') returning id", [org, entity, `pp-${++n}.csv`])).id,
    );
  const done = (job: string) => run(owner, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
  const openingBalance = (on: { contact?: string; company?: string }, job: string | null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "select public.opening_balance_set($1, $2, $3, 700, $4, $5, $6) as id", [
          org,
          on.contact ?? null,
          on.company ?? null,
          day(-40),
          day(-10),
          job,
        ])
      ).id,
    );
  const promise = (subject: { contact?: string; company?: string; document?: string }) =>
    run(owner, (q) =>
      q("insert into public.payment_promises (organization_id, contact_id, company_id, document_id, promised_date) values ($1, $2, $3, $4, $5)", [
        org,
        subject.contact ?? null,
        subject.company ?? null,
        subject.document ?? null,
        day(3),
      ]),
    );
  const worked = (type: "contact" | "company", id: string, job: string) =>
    asAdmin(async (q) => (await one<{ w: boolean }>(q, "select app.import_record_worked($1, $2, $3, now() - interval '1 hour', $4) as w", [org, type, id, job])).w);

  beforeAll(async () => {
    owner = await createUser("ppw-owner");
    org = await createOrg(owner.id, "עסק ההבטחות שעבדו");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [
        org,
        JSON.stringify({ documents: true, payments: true, balances: true, collection: true }),
      ]),
    );
  });

  it("an imported contact: a customer promise, or a promise on the import's own opening balance, is work", async () => {
    for (const on of ["customer", "document"] as const) {
      const job = await importJob("contact");
      const contact = await run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, import_job_id) values ($1, $2, $3, $4) returning id", [org, `מיובא ${++n}`, owner.id, job])).id,
      );
      const ob = await openingBalance({ contact }, job);
      await done(job);
      // the job's own opening balance is part of the import
      expect(await worked("contact", contact, job)).toBe(false);
      await promise(on === "customer" ? { contact } : { document: ob });
      expect(await worked("contact", contact, job), on).toBe(true);
    }
  });

  it("the importer's own undo keeps a contact with a promise on the import's opening balance", async () => {
    // an admin records the balance into their own import, then is made a member who holds the import key and undoes it
    // (undo_own_import asks whether the records were worked; the path of test 267)
    const former = await addMember(org, owner.id, "admin", "ppw-former");
    const job = await run(former, async (q) =>
      (await one<{ id: string }>(q, "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'ppw.csv', 'skip') returning id", [org])).id,
    );
    const contact = await run(former, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, import_job_id) values ($1, $2, $3, $4) returning id", [org, `מיובא ${++n}`, former.id, job])).id,
    );
    const ob = await run(former, async (q) =>
      (await one<{ id: string }>(q, "select public.opening_balance_set($1, $2, null, 700, $3, $4, $5) as id", [org, contact, day(-40), day(-10), job])).id,
    );
    await run(former, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
    await promise({ document: ob });
    await asAdmin((q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, former.id]));
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{import}')", [org, former.id]));
    const r = await run(former, async (q) => (await one<{ r: { done: number; kept: number } }>(q, "select public.undo_own_import($1, $2) as r", [org, job])).r);
    expect(r).toMatchObject({ done: 0, kept: 1 });
    expect(await asAdmin(async (q) => (await one<{ d: string | null }>(q, "select deleted_at as d from public.contacts where id = $1", [contact])).d)).toBeNull();
  });

  it("an imported company: a promise on it, or on its opening balance, is work", async () => {
    for (const on of ["customer", "document"] as const) {
      const job = await importJob("company");
      const company = await run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id, import_job_id) values ($1, $2, $3, $4) returning id", [org, `חברה מיובאת ${++n}`, owner.id, job])).id,
      );
      const ob = await openingBalance({ company }, job);
      await done(job);
      expect(await worked("company", company, job)).toBe(false);
      await promise(on === "customer" ? { company } : { document: ob });
      expect(await worked("company", company, job), on).toBe(true);
    }
  });

  it("sample data: a promise keeps a sample contact or company", async () => {
    await run(owner, (q) => q("select public.sample_data_add($1)", [org]));
    const samples = await asAdmin(async (q) =>
      (
        await q<{ contact_id: string | null; company_id: string | null; snapshot: unknown }>(
          "select contact_id, company_id, snapshot from app.sample_records where organization_id = $1 and (contact_id is not null or company_id is not null)",
          [org],
        )
      ).rows,
    );
    const untouched = (type: "contact" | "company", id: string) =>
      asAdmin(async (q) => {
        const snapshot = samples.find((s) => (type === "contact" ? s.contact_id : s.company_id) === id)!.snapshot;
        return (await one<{ u: boolean }>(q, "select app.sample_untouched($1, $2, $3, $4) as u", [org, type, id, snapshot])).u;
      });
    // A real promise needs an open document of the customer, and recording one already makes the record kept (the document,
    // its timeline entry), so each promise line is checked on its own: rows written without their triggers.
    const raw = (sql: string, params: unknown[]) =>
      asAdmin(async (q) => {
        await q("set local session_replication_role = replica");
        const r = await q<{ id: string }>(sql, params);
        await q("set local session_replication_role = origin");
        return r.rows[0]?.id;
      });

    // the sample contact without a company (a contact of a company promises through its company)
    const contact = samples.find((s) => s.contact_id && (s.snapshot as { company_id?: string | null }).company_id == null)!.contact_id!;
    expect(await untouched("contact", contact)).toBe(true);
    await raw("insert into public.payment_promises (organization_id, contact_id, promised_date) values ($1, $2, $3)", [org, contact, day(3)]);
    expect(await untouched("contact", contact)).toBe(false);

    const company = samples.find((s) => s.company_id)!.company_id!;
    expect(await untouched("company", company)).toBe(true);
    // a company's own document (an opening balance) alone is not judged here (known follow-up); a promise on it is
    const ob = await raw(
      "insert into public.accounting_documents (organization_id, company_id, doc_type, doc_date, amount_agorot) values ($1, $2, 'opening_balance', $3, 700) returning id",
      [org, company, day(-40)],
    );
    expect(await untouched("company", company)).toBe(true);
    const onDocument = await raw("insert into public.payment_promises (organization_id, document_id, promised_date) values ($1, $2, $3) returning id", [org, ob, day(3)]);
    expect(await untouched("company", company)).toBe(false);
    await raw("delete from public.payment_promises where id = $1", [onDocument]);
    expect(await untouched("company", company)).toBe(true);
    await raw("insert into public.payment_promises (organization_id, company_id, promised_date) values ($1, $2, $3)", [org, company, day(3)]);
    expect(await untouched("company", company)).toBe(false);
  });
});
