import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// DOC-07 / DOC-08 / DOC-09 (owner (270) (1) א: behind a fake provider): issuing with the person's own session (migration
// invoice_issue): one request per idempotency key, totals by the database, the customer's missing details, and the document
// recorded once with the provider's id.

const REVIEWED_MD5: Record<string, string> = {
  // DOC-14 (migration invoice_credit, 17 November 2026): who credits (owners, admins, the `issue_credits` grant), what is
  // left of an original under its lock, and the credit request on DOC-07's path (the same job kind, ids only in the queue)
  // owner (409) ב: the credit's reason on the recorded credit invoice, frozen, erased with the document's lines
  "app.accounting_document_lines_credit_reason_erase": "7d23c3a56f8fbaa7da3da4ab1abd422e",
  // delta review of 267cfe82 (was 1cb8fa29…): definer; a hand credit of a provider's original is refused above what is left
  // (app.invoice_credit_hand_room, hint invoice_credit:hand_over), outsider guard first; owner (412) א: the DETAIL carries
  // what is left in agorot
  // third review (was 86780cf2…): the lock only after the outsider guard; the trigger (renamed accounting_documents_zz_credit_lock)
  // fires after accounting_documents_source, which refuses an unreadable original first
  "app.accounting_documents_credit_lock": "6f633478679cd3ffd0bdc8b790f5e61c",
  "app.accounting_documents_credit_reason": "ab5c28b9476756c4c045404d2b518dc7",
  // owner (408) ד (was 8b90bf6b4eabb74269b2438e4de4957b): anyone but owners and admins needs issue_documents AND issue_credits
  "app.can_issue_credits": "43cebed0ebd2a6d289451249fd7c4ff1",
  // delta review: the credit's reason erased when the document's audit entries are erased (and that change's entry erased)
  "app.audit_log_credit_reason_erase": "6b3d2c77a1bd657fc99844a3f5546bf8",
  "app.can_issue_documents": "0c0c9283979082f055a3ad3f6dd9bfb2",
  "app.invoice_credit_check": "99ca3d8cdab23c0ec8804b35c5c21255",
  // after the review of 13af24a5: open builds its lines through app.invoice_credit_lines (exact totals) and folds the
  // reason's white space; room_of counts only requests that reserve (app.invoice_credit_reserves), an unsplit hand credit
  // by the original's VAT share, and lists the reserving requests (were 30dbdb56…, 29da47b2…)
  // owner (411) ב (were ccb08610…, 51166572…): no VAT = an exempt line; a mixed original's partial credit is made of chosen
  // lines (each within what is left of it), its full rest of every line's remaining part; the VAT aimed by the rate
  "app.invoice_credit_lines": "621988956a883a1bfac77c6fe3282b34",
  // delta review (were 9e6b05b0…, 8b20c482…, 19621256…): the reason folds U+2028/U+2029 and refuses bidi/zero-width; reserves
  // no longer reads the job's live attempts (provider_absent_at is stamped once); a provider's credit cancelled here keeps
  // counting; the reserving rows say whether the provider issued them
  "app.invoice_credit_hand_room": "c78a4d2d2b073575cf2bd99233d3eafa",
  "app.invoice_credit_open": "98d8923b38f373fd8ba01a5ea842f1b6",
  "app.invoice_credit_reserves": "deaa443c18de692195c57f0b31fbc3ca",
  // owner (411) ב (was 10e21d5f…): also answers mixed, the lines' price mode and what is left of each line
  // third review (was d9124584…): the reserving rows say whether their job can still run (job_waiting)
  "app.invoice_credit_room_of": "d18755928b5e6d940ff7d5f79b2613b0",
  "app.invoice_customer": "ed6e671201d300d02e7c3b2698a950c5",
  // DOC-13 (migration invoice_provider_customers): the hash of the customer block a request sends
  "app.invoice_customer_details_hash": "507dba4f9b7ffb23d2de9363fe9ca3ab",
  "app.invoice_issue_late_notice": "3090ce52d01375b74fe5bf366f167d09",
  "app.invoice_issue_mark_stale": "e07b2752013f0150e394ae229b03a566",
  // owner (410) ב (migration invoice_provider_customers; was 23c6faeec798694d0fbd551aa9d17a8d): 021297's body, a line may
  // name a product of this business (kept in the stored request); every other rule unchanged
  "app.invoice_issue_open": "392e6312479656cdb73c5eb1166e657e",
  // DOC-14: 021297's body, plus a credit's `reason` emptied ("הסיבה נמחקה (מחיקת פרטיות)"). Was
  // e96968aa5ab2447b37def9ae07090871; the customer block and the line texts as before.
  "app.invoice_issue_payload_erased": "761192b039364ceeb9e5f43e1dd2f8aa",
  "app.invoice_issue_requests_erase": "3b197f71c7ec0490fa4203b05d02d040",
  "app.invoice_issuer_check": "dad7cda653a2bdae7589597f920fa405",
  // owner (410) ב: our product's details for the provider, the kept product ids for the claim, and their keeping
  "app.invoice_product_details": "960322501c84fa05e97f4c6c688dd378",
  // DOC-13: the kept provider customer id, read for the claim and written from the record (ids and a hash only; never raises)
  "app.invoice_provider_customer_keep": "6a54fb7313d1ce347e33b1577953ccfe",
  "app.invoice_provider_customer_of": "e2b869a9db1037aa532ea7c94d4c4332",
  "app.invoice_provider_of": "64b18ad8214c63840c0689ad3ad4d3de",
  "app.invoice_provider_products_keep": "21d9fac985b6d4b328eacc60bec6a8c1",
  "app.invoice_provider_products_of": "82760c861a9b91e4350c07581825944e",
  "app.invoice_provider_usable": "6caf3afd4259a3055e8aa1fd6ab43356",
  "app.invoice_source": "ba98c89124588ce8250c141a9d02bd6a",
  // LNK-02 (migration payment_link_pages; was c14758df… and 7e63dd97…): payment_link.create added, exactly {link_id}; every
  // earlier kind's branch, invoice.issue's included, is unchanged
  "app.job_kinds": "ac248c413963f96a8a04f46dbb895ec3",
  "app.job_payload_ok": "f56961310204ad5f229cef1639a108e4",
  "app.merge_invoice_issue_requests": "1cd6caad6241cf0e7e225ae508862f6e",
  "public.invoice_credit_begin": "b078292f9cd4aac6ec416ee597fe0d7e",
  // delta review (was 89d27137…): refuses a request the provider issued; stamps credit_released_at / _by only
  // third review (was 2db840dc…): refused while the request's job can still run (invoice_credit:release_wait)
  "public.invoice_credit_release": "155a8e54dff3e432ce39f93fc5864dd2",
  "public.invoice_credit_room": "076ecc3dec87cf5571b7d6e89fad3e8f",
  "public.invoice_issue_begin": "613ffef8dbbadc4447794a7bc92b8446",
  // DOC-13 (migration invoice_provider_customers, 17 November 2026): 021297's body, the last return also answers
  // `provider_customer` (app.invoice_provider_customer_of: the kept id and whether its details are the ones sent now). Was
  // e07a0e1396cfbee899a9d7a3d2fb61f4; every refusal, the late branch and the lease check are unchanged.
  // "public.invoice_issue_claim": "62e2cfc8d9d4e69f16c5e6692cbfc737" (DOC-13), then DOC-14 (migration invoice_credit): one
  // more refusal before the provider checks: a credit whose original is no longer an active tax invoice of the request's
  // provider with the stored provider id (invoice_credit:original). Nothing else changed.
  // "public.invoice_issue_claim": "26a83db611a347f5e529ad93b99511bc", then owner (410) ב: the last answer also carries
  // `provider_products` (app.invoice_provider_products_of). Nothing else changed.
  // delta review (was 40a247d6…): answering `finished` on the first try for a request closed or marked stale before, it stamps
  // provider_absent_at (never sent). Nothing else changed.
  "public.invoice_issue_claim": "8f896a77ea2553cc8a27792a839e9f1c",
  // DOC-14 (migration invoice_credit): 021297's body; marking a CREDIT request `checked` is for owners and admins only (hint
  // invoice_credit:check_admin). Was a666cd68ecd81f94257111bc67cb5741; issue requests unchanged.
  // delta review (was 448d0f82…): closing a request whose job was never claimed stamps provider_absent_at (never sent)
  "public.invoice_issue_close": "d5cd724f4a8aa7c79dc86e1e7ee9829e",
  // DOC-10 (migration allocation_failure, 17 November 2026): 021297's body plus the provider's allocation outcome (the
  // `allocation` object or the old keys, codes from app.allocation_failure_codes(), 'invalid_number' for a number that is
  // not digits, the mark written on the recorded document). Rechecked: lease and request locks, every refusal and retry
  // branch, the late lookup, the server-only insert with the claims set aside and restored, the audit actor, the deadlock
  // re-raise, unchanged; no amount is compared for the allocation. After the review of 5f84845c: an outcome that cannot be
  // read (an unknown status, a missing or non-string number or code, not an object) no longer raises 22023, since the
  // provider already issued the document; it is recorded and marked 'other' (tax invoices only). Nothing else changed.
  // DOC-13 (migration invoice_provider_customers): 021310's body plus one step after the answer's shape check: a string
  // `provider_customer_id` is kept through app.invoice_provider_customer_keep (never raises but a deadlock). Was
  // 2107bb86f74cdc70719a4592f647f191; nothing else changed.
  // "public.invoice_issue_record": "cde0ccba2afe470ad8917b102423684e" (DOC-13), then DOC-14 (migration invoice_credit): the
  // insert also names original_document_id, for a credit invoice only (from the stored request; DOC-02's trigger judges it
  // again). Nothing else changed.
  // after the review of 13af24a5 (was 86da6343a1b9648268a1a06664f44cc7): a late lookup's not_at_provider also stamps
  // provider_absent_at (known never issued; the request stays final as before). Nothing else changed.
  // "public.invoice_issue_record": "f275a7f68ceecb07964af9fdb0d4b1cb", then owners (409)-(411) ב: keeps
  // `provider_product_ids`, writes each line's product_id and a credit line's credited_line_id, and the credit's
  // credit_reason. Nothing else changed.
  "public.invoice_issue_record": "af44afdf4b8cb59a6c1d1c51896bdf45",
  // DOC-14 third review (migration invoice_credit; was a3568e808238728700c48a0fc061a4be): 021297's body without a released
  // credit request (credit_released_at). Nothing else changed.
  "public.invoice_issue_requests_open": "ea7683d93eec4d906b6d4ec61610d484",
  "public.invoice_issue_state": "61f1e0d0216e257a93d4b0b5f5cd7ee0",
  "public.invoice_provider_check_recorded": "47a98ea21aa0dcd33f782fe6d1fce73e",
  "public.invoice_provider_connect": "c5c9188e98b96be21d420dad3b1a7a12",
  "public.invoice_provider_disconnect": "2f6d1480f85014c46cfe9b7befcd9f90",
};

const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

describe("issuing through the invoice provider", () => {
  let owner: U, admin: U, manager: U, member: U, issuer: U, viewer: U, outsider: U;
  let org: string, otherOrg: string, bareOrg: string;
  let pipelineId: string, stageId: string, wonStageId: string;
  let person: string, company: string, businessContact: string, deal: string, companyDeal: string, otherDeal: string;

  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const connect = (u: U, orgId = org, provider = "fake") =>
    run(u, (q) => q("select public.invoice_provider_connect($1, $2)", [orgId, provider]));
  const lines = [
    { description: "ייעוץ", quantity: 2, unit_price_agorot: 10000, discount_agorot: 0, vat_exempt: false },
    { description: "נסיעות", quantity: 1, unit_price_agorot: 5000, discount_agorot: 1000, vat_exempt: true },
  ];
  const doc = (extra: Record<string, unknown> = {}) => ({ doc_type: "tax_invoice", prices_include_vat: false, lines, ...extra });
  const begin = (u: U, key: string, kind: string, id: string, d: Record<string, unknown> = doc(), orgId = org) =>
    run(u, async (q) =>
      (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_issue_begin($1, $2, $3, $4, $5) as r", [orgId, key, kind, id, JSON.stringify(d)])).r,
    );
  // owner (398) א: the background worker's path (service_role): claim the request's job, the claim, the provider's answer
  // recorded, the job finished. Other claimed jobs are handed back untried.
  type Job = { id: string; lease: string; payload: Record<string, string> };
  const claimJob = async (request: string): Promise<Job> => {
    const jobId = (await asAdmin((q) => one<{ j: string }>(q, "select job_id as j from app.invoice_issue_requests where id = $1", [request]))).j;
    const rows = await asService(async (q) => (await one<{ r: Job[] }>(q, "select public.claim_jobs(array['invoice.issue'], 100) as r")).r);
    for (const other of rows.filter((x) => x.id !== jobId)) {
      await asService((q) => q("select public.finish_job($1, $2, false, null, false, false)", [other.id, other.lease]));
    }
    const job = rows.find((x) => x.id === jobId);
    if (!job) throw new Error("the request's job was not claimed");
    return job;
  };
  const claimOf = (job: Job) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_issue_claim($1, $2) as r", [job.id, job.lease])).r);
  const record = (job: Job, answer: Record<string, unknown>) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_issue_record($1, $2, $3) as r", [job.id, job.lease, JSON.stringify(answer)])).r);
  const requestRow = (request: string) =>
    asAdmin((q) => one<Record<string, unknown>>(q, "select status, error_code as code, document_id, number from app.invoice_issue_requests where id = $1", [request]));
  const CHECK_TITLE = "בדקו בקשת הפקה אצל ספק החשבוניות";
  const toldCheck = (request: string, since: string | null = null) =>
    // the notice names nothing of the request: counted by the people of this test's request, after it began
    asAdmin(async (q) =>
      (
        await q<{ user_id: string }>(
          `select n.user_id from public.notifications n
             join app.invoice_issue_requests r on r.id = $2
            where n.organization_id = $1 and n.title = $3 and n.created_at >= coalesce($4::timestamptz, r.created_at)`,
          [org, request, CHECK_TITLE, since],
        )
      ).rows.map((x) => x.user_id).sort(),
    );
  const listed = (u: U) =>
    run(u, async (q) => (await one<{ r: { id: string; status: string; code: string | null }[] }>(q, "select public.invoice_issue_requests_open($1) as r", [org])).r);
  const work = async (request: string, res: Record<string, unknown> = result(), between?: () => Promise<unknown>) => {
    const job = await claimJob(request);
    const claim = await claimOf(job);
    let out: Record<string, unknown>;
    if (typeof claim.refused === "string") {
      out = { ...(await requestRow(request)), refused: claim.refused };
    } else {
      if (between) await between();
      out = await record(job, { ok: true, ...res });
    }
    await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
    return out;
  };
  const requests = (key: string) => asAdmin((q) => count(q, "select 1 from app.invoice_issue_requests where idempotency_key = $1", [key]));
  let seq = 0;
  const result = () => ({ provider_document_id: `fake_doc_${++seq}`, number: `9000${seq}`, allocation_number: "123456789" });

  beforeAll(async () => {
    owner = await createUser("inv-owner");
    org = await createOrg(owner.id, "עסק החשבוניות");
    admin = await addMember(org, owner.id, "admin", "inv-admin");
    manager = await addMember(org, owner.id, "manager", "inv-manager");
    member = await addMember(org, owner.id, "member", "inv-member");
    issuer = await addMember(org, owner.id, "member", "inv-issuer");
    viewer = await addMember(org, owner.id, "viewer", "inv-viewer");
    outsider = await createUser("inv-outsider");
    otherOrg = await createOrg(outsider.id, "עסק זר");
    bareOrg = await createOrg(owner.id, "עסק בלי מסמכים");
    await asAdmin((q) =>
      q(
        "update public.subscriptions set feature_overrides = '{\"documents\": true, \"granular_permissions\": true, \"quotes\": true, \"orders\": true, \"products\": true}' where organization_id = any($1::uuid[])",
        [[org, otherOrg]],
      ),
    );
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"documents\": false}' where organization_id = $1", [bareOrg]));
    await run(owner, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [org]));
    await run(outsider, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [otherOrg]));
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, issuer.id, ["issue_documents"]]));
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
    wonStageId = pipe.stages.find((s) => s.kind === "won")!.id;
    [person, company, businessContact] = await run(owner, async (q) => {
      const p = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, last_name, owner_id) values ($1, 'דנה', 'לוי', $2) returning id", [org, owner.id])).id;
      const c = (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, 'אקמה בע\"מ', $2) returning id", [org, owner.id])).id;
      const b = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, 'יוסי', $2, $3) returning id", [org, c, owner.id])).id;
      return [p, c, b];
    });
    deal = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [org, pipelineId, stageId, person, owner.id])).id,
    );
    companyDeal = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id, owner_id) values ($1, 'עסקה עסקית', $2, $3, $4, $5, $6) returning id", [org, pipelineId, stageId, businessContact, company, owner.id])).id,
    );
    const otherPipe = await defaultPipeline(otherOrg);
    await connect(admin);
    await run(admin, (q) => q("update public.invoice_provider_settings set locale = 'en', provider_sends_email = true where organization_id = $1", [org]));
    otherDeal = await run(outsider, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'זר', $2, $3, $4) returning id", [otherOrg, otherPipe.pipelineId, otherPipe.stages.find((s) => s.kind === "open")!.id, outsider.id])).id,
    );
  });

  // each test starts without open requests of earlier ones (a reload within 15 minutes would reach them, rule 5)
  afterEach(() =>
    asAdmin(async (q) => {
      await q("update app.invoice_issue_requests set status = 'stale', error_code = 'stale', finished_at = now() where organization_id = $1 and status = 'pending'", [org]);
      await q("update app.jobs set status = 'done', lease_id = null, locked_until = null, finished_at = now() where kind = 'invoice.issue' and status in ('queued', 'running', 'failed')");
    }),
  );

  describe("issuing (DOC-07, DOC-08, DOC-09)", () => {
    it("DOC-17: managers, members and viewers without issue_documents, and outsiders, are refused", async () => {
      for (const u of [manager, member, viewer, outsider]) {
        expect((await pgError(begin(u, randomUUID(), "deal", deal))).code, u.email).toBe("42501");
      }
    });

    it("the request holds the database's totals, the customer and the defaults", async () => {
      const key = randomUUID();
      const r = await begin(issuer, key, "deal", deal);
      expect(r.status).toBe("pending");
      expect(r.provider).toBe("fake");
      const req = r.request as { totals: Record<string, number | boolean>; customer: Record<string, unknown>; locale: string; send_email: boolean; lines: unknown[] };
      // 2 x 100.00 taxable + 40.00 exempt (50.00 less a 10.00 line discount); VAT only on the taxable part
      expect(req.totals.net_agorot).toBe(24000);
      expect(Number(req.totals.total_agorot)).toBe(24000 + Number(req.totals.vat_agorot));
      expect(Number(req.totals.vat_agorot)).toBe(Math.round((20000 * Number(req.totals.rate_bp)) / 10000));
      expect(req.customer).toMatchObject({ name: "דנה לוי", is_business: false, external_ref: `contact:${person}` });
      expect(req.locale).toBe("en");
      expect(req.send_email).toBe(true);
      expect(req.lines).toHaveLength(2);
    });

    it("the same key twice answers the same request; someone else's key is refused", async () => {
      const key = randomUUID();
      const a = await begin(issuer, key, "deal", deal);
      const b = await begin(issuer, key, "deal", deal, doc({ lines: [lines[0]] }));
      expect(b.request_id).toBe(a.request_id);
      expect(b.request).toEqual(a.request);
      expect(await requests(key)).toBe(1);
      expect((await pgError(begin(owner, key, "deal", deal))).hint).toBe("invoice:request");
    });

    it("DOC-08: a business customer without a tax id or an address is blocked with what is missing", async () => {
      const r = await begin(owner, randomUUID(), "deal", companyDeal);
      expect(r).toEqual({ status: "blocked", problems: ["tax_id", "address"] });
      const preview = await run(owner, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_issue_customer($1, 'deal', $2) as r", [org, companyDeal])).r);
      expect(preview).toMatchObject({ name: 'אקמה בע"מ', is_business: true, problems: ["tax_id", "address"] });
      await run(owner, (q) => q("update public.companies set tax_id = '000000026', billing_address = 'הרצל 1, תל אביב' where id = $1", [company]));
      const ok = await begin(owner, randomUUID(), "deal", companyDeal);
      expect(ok.status).toBe("pending");
      expect((ok.request as { customer: Record<string, unknown> }).customer).toMatchObject({ tax_id: "000000026", address: "הרצל 1, תל אביב", is_business: true });
    });

    it("refuses a bad type, date, due date, lines or total", async () => {
      expect((await pgError(begin(owner, randomUUID(), "deal", deal, doc({ doc_type: "credit_invoice" })))).hint).toBe("invoice:type");
      expect((await pgError(begin(owner, randomUUID(), "deal", deal, doc({ doc_date: "2999-01-01" })))).hint).toBe("invoice:date");
      expect((await pgError(begin(owner, randomUUID(), "deal", deal, doc({ doc_type: "receipt", due_date: "2026-12-31" })))).hint).toBe("invoice:due_date");
      expect((await pgError(begin(owner, randomUUID(), "deal", deal, doc({ lines: [] })))).hint).toBe("invoice:lines");
      expect((await pgError(begin(owner, randomUUID(), "deal", deal, doc({ lines: [{ description: " ", quantity: 1, unit_price_agorot: 100 }] })))).hint).toBe("invoice:lines");
      expect((await pgError(begin(owner, randomUUID(), "deal", deal, doc({ lines: [{ description: "x", quantity: 0.0001, unit_price_agorot: 100 }] })))).hint).toBe("invoice:lines");
      expect((await pgError(begin(owner, randomUUID(), "deal", deal, doc({ lines: [{ description: "x", quantity: 1, unit_price_agorot: 0 }] })))).hint).toBe("invoice:total");
    });

    it("a source the caller does not read, or of another business, is not found or refused", async () => {
      expect((await pgError(begin(owner, randomUUID(), "deal", otherDeal))).hint).toBe("invoice:source");
      expect((await pgError(begin(outsider, randomUUID(), "deal", deal, doc(), org))).code).toBe("42501");
      expect((await pgError(begin(owner, randomUUID(), "quote", deal))).hint).toBe("invoice:source");
    });

    it("begin queues one invoice.issue job holding the request's id only", async () => {
      const r = await begin(issuer, randomUUID(), "deal", deal);
      const job = await asAdmin((q) => one<{ payload: unknown; kind: string }>(q, "select j.payload, j.kind from app.jobs j join app.invoice_issue_requests r on r.job_id = j.id where r.id = $1", [r.request_id]));
      expect(job).toEqual({ kind: "invoice.issue", payload: { request_id: r.request_id } });
    });

    it("no person claims a request or records a provider's answer (owner (398) א)", async () => {
      const r = await begin(issuer, randomUUID(), "deal", deal);
      const jobId = (await asAdmin((q) => one<{ j: string }>(q, "select job_id as j from app.invoice_issue_requests where id = $1", [r.request_id]))).j;
      for (const u of [owner, issuer]) {
        expect((await pgError(run(u, (q) => q("select public.invoice_issue_claim($1, $2)", [jobId, randomUUID()])))).code).toBe("42501");
        expect((await pgError(run(u, (q) => q("select public.invoice_issue_record($1, $2, $3)", [jobId, randomUUID(), JSON.stringify({ ok: true, ...result() })])))).code).toBe("42501");
      }
      // a dead lease answers stale and changes nothing
      expect(await asService(async (q) => (await one<{ r: unknown }>(q, "select public.invoice_issue_claim($1, $2) as r", [jobId, randomUUID()])).r)).toEqual({ refused: "stale" });
      expect((await requestRow(r.request_id as string)).status).toBe("pending");
    });

    it("the worker records the document once, from the request's own amounts, with the provider's id", async () => {
      const r = await begin(issuer, randomUUID(), "deal", deal);
      const out = result();
      const done = await work(r.request_id as string, out);
      expect(done.status).toBe("issued");
      const row = await asAdmin((q) =>
        one<Record<string, unknown>>(
          q,
          "select provider, provider_document_id, number, doc_type, amount_agorot, net_agorot, vat_agorot, allocation_number, deal_id, contact_id, created_by from public.accounting_documents where id = $1",
          [done.document_id],
        ),
      );
      const totals = (r.request as { totals: Record<string, number> }).totals;
      expect(row).toMatchObject({
        provider: "fake",
        provider_document_id: out.provider_document_id,
        number: out.number,
        doc_type: "tax_invoice",
        amount_agorot: String(totals.total_agorot),
        net_agorot: String(totals.net_agorot),
        allocation_number: "123456789",
        deal_id: deal,
        contact_id: person,
        created_by: issuer.id,
      });
      expect(await asAdmin((q) => count(q, "select 1 from public.accounting_document_lines where document_id = $1 and created_by = $2", [done.document_id, issuer.id]))).toBe(2);
      const replay = await begin(issuer, (await asAdmin((q) => one<{ k: string }>(q, "select idempotency_key as k from app.invoice_issue_requests where id = $1", [r.request_id]))).k, "deal", deal);
      expect(replay).toMatchObject({ status: "issued", document_id: done.document_id });
      // the issuer reads it like any document of the deal
      expect(await run(owner, (q) => count(q, "select 1 from public.accounting_documents where id = $1", [done.document_id]))).toBe(1);
    });

    it("a person still cannot name a provider on a hand-recorded document", async () => {
      const error = await pgError(
        run(owner, (q) =>
          q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot, provider, provider_document_id) values ($1, $2, 'receipt', 'R-1', 100, 'fake', 'x')", [org, person]),
        ),
      );
      expect(error.code).toBe("42501");
    });

    // DOC-10: the provider's allocation outcome (a number, a failure with a code from the closed list, or not needed) is kept as
    // it answered; the system never decides whether a number was needed
    const allocationOf = (documentId: unknown) =>
      asAdmin((q) =>
        one<Record<string, unknown>>(
          q,
          "select allocation_number, allocation_error_code, allocation_failed_at is not null as marked from public.accounting_documents where id = $1",
          [documentId],
        ),
      );
    const requestFailure = (request: unknown) =>
      asAdmin(async (q) => (await one<{ f: string | null }>(q, "select allocation_failure as f from app.invoice_issue_requests where id = $1", [request])).f);
    const issueWith = async (allocation: unknown, d: Record<string, unknown> = doc()) => {
      const r = await begin(issuer, randomUUID(), "deal", deal, d);
      const { allocation_number: _drop, ...rest } = result();
      void _drop;
      const done = await work(r.request_id as string, { ...rest, allocation });
      expect(done.status).toBe("issued");
      return { request: r.request_id, document: done.document_id };
    };

    it("DOC-10: an allocated number is kept, a failure marks the document with its code, not needed leaves both empty", async () => {
      const allocated = await issueWith({ status: "allocated", number: "987654321" });
      expect(await allocationOf(allocated.document)).toEqual({ allocation_number: "987654321", allocation_error_code: null, marked: false });
      const failed = await issueWith({ status: "failed", code: "tax_authority_unavailable" });
      expect(await allocationOf(failed.document)).toEqual({ allocation_number: null, allocation_error_code: "tax_authority_unavailable", marked: true });
      expect(await requestFailure(failed.request)).toBe("tax_authority_unavailable");
      // the provider said none was needed (its threshold): nothing marked, whatever the amount
      const notNeeded = await issueWith({ status: "not_needed" });
      expect(await allocationOf(notNeeded.document)).toEqual({ allocation_number: null, allocation_error_code: null, marked: false });
      // a code outside the closed list is kept as 'other'; a number that is not digits is marked, never kept
      const unknown = await issueWith({ status: "failed", code: "סירוב חופשי" });
      expect((await allocationOf(unknown.document)).allocation_error_code).toBe("other");
      const garbage = await issueWith({ status: "allocated", number: "12-34" });
      expect(await allocationOf(garbage.document)).toEqual({ allocation_number: null, allocation_error_code: "invalid_number", marked: true });
      // a receipt carries neither
      const receipt = await issueWith({ status: "failed", code: "other" }, doc({ doc_type: "receipt" }));
      expect(await allocationOf(receipt.document)).toEqual({ allocation_number: null, allocation_error_code: null, marked: false });
    });

    it("DOC-10: a worker built before DOC-10 still records (allocation_number, or its words as 'other')", async () => {
      const r = await begin(issuer, randomUUID(), "deal", deal);
      const { allocation_number: _drop, ...rest } = result();
      void _drop;
      const done = await work(r.request_id as string, { ...rest, allocation_number: null, allocation_failure: "שגיאה אצל הספק" });
      expect(await allocationOf(done.document_id)).toEqual({ allocation_number: null, allocation_error_code: "other", marked: true });
    });

    it("DOC-10: an outcome that cannot be read never refuses the issued document: it is recorded and marked 'other'", async () => {
      for (const allocation of [
        { status: "pending" },
        { status: "allocated" },
        { status: "allocated", number: 123456789 },
        { status: "failed" },
        { status: "failed", code: 7 },
        "allocated",
        ["allocated"],
      ]) {
        const issued = await issueWith(allocation);
        expect(await allocationOf(issued.document), JSON.stringify(allocation)).toEqual({ allocation_number: null, allocation_error_code: "other", marked: true });
        expect(await requestFailure(issued.request)).toBe("other");
      }
      // a type that carries no allocation number is never marked
      const proforma = await issueWith({ status: "pending" }, doc({ doc_type: "proforma" }));
      expect(await allocationOf(proforma.document)).toEqual({ allocation_number: null, allocation_error_code: null, marked: false });
    });

    it("DOC-10: the codes of app.allocation_failure_codes() are the codes the constraint allows", async () => {
      const codes = await asAdmin(async (q) => (await one<{ c: string[] }>(q, "select app.allocation_failure_codes() as c")).c);
      const def = await asAdmin(async (q) =>
        (await one<{ d: string }>(q, "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'accounting_documents_allocation_failure_shape' and conrelid = 'public.accounting_documents'::regclass")).d,
      );
      const listed = /allocation_error_code\s*=\s*ANY\s*\(\s*ARRAY\[([^\]]+)\]/i.exec(def);
      expect(listed, def).not.toBeNull();
      const allowed = [...(listed?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      expect([...allowed].sort()).toEqual([...codes].sort());
      expect(codes.length).toBeGreaterThan(0);
    });

    it("DOC-10: the mark is the server's: a person can neither write it nor change it; readers of the document see it", async () => {
      const failed = await issueWith({ status: "failed", code: "customer_tax_id" });
      const insert = await pgError(
        run(owner, (q) =>
          q(
            "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot, allocation_error_code, allocation_failed_at) values ($1, $2, 'tax_invoice', 'M-1', 100, 'other', now())",
            [org, person],
          ),
        ),
      );
      expect(insert.code).toBe("42501");
      expect((await pgError(run(owner, (q) => q("update public.accounting_documents set allocation_error_code = null, allocation_failed_at = null where id = $1", [failed.document])))).code).toBe("42501");
      // a definer path with a session still cannot change it
      const frozen = await pgError(
        asAdmin(async (q) => {
          await q("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [owner.id, JSON.stringify({ sub: owner.id, role: "authenticated" })]);
          await q("update public.accounting_documents set allocation_error_code = 'other' where id = $1", [failed.document]);
        }),
      );
      expect(frozen.hint).toBe("document:frozen");
      for (const reader of [owner, admin, issuer]) {
        expect((await run(reader, (q) => one<{ c: string | null }>(q, "select allocation_error_code as c from public.accounting_documents where id = $1", [failed.document])))?.c).toBe("customer_tax_id");
      }
      // the shape holds for every writer: a number beside the mark, a code outside the list, a mark on a receipt, half a mark
      expect((await pgError(asAdmin((q) => q("update public.accounting_documents set allocation_number = '1' where id = $1", [failed.document])))).code).toBe("23514");
      for (const [type, code, at] of [
        ["tax_invoice", "nope", "now()"],
        ["receipt", "other", "now()"],
        ["tax_invoice", "other", "null"],
      ]) {
        const insertMark = `insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot, allocation_error_code, allocation_failed_at) values ($1, $2, '${type}', 'S-${type}-${code}-${at}', 100, '${code}', ${at})`;
        expect((await pgError(asAdmin((q) => q(insertMark, [org, person])))).code, insertMark).toBe("23514");
      }
      // frozen once written, for the server too (a number the provider gets later is a follow-up)
      expect((await pgError(asAdmin((q) => q("update public.accounting_documents set allocation_number = '555', allocation_error_code = null, allocation_failed_at = null where id = $1", [failed.document])))).hint).toBe("document:frozen");
      expect(await allocationOf(failed.document)).toEqual({ allocation_number: null, allocation_error_code: "customer_tax_id", marked: true });
    });

    it("a number recorded by hand before stays on the request as unrecorded; nothing is recorded twice", async () => {
      await run(owner, (q) =>
        q("select public.accounting_document_record($1, $2, null)", [org, JSON.stringify({ contact_id: person, doc_type: "tax_invoice", number: "777", amount_agorot: 100 })]),
      );
      const r = await begin(owner, randomUUID(), "contact", person);
      const done = await work(r.request_id as string, { provider_document_id: "fake_doc_dup", number: "777", allocation_number: null });
      expect(done).toMatchObject({ status: "unrecorded", number: "777", code: "document:duplicate" });
      expect(await asAdmin((q) => count(q, "select 1 from public.accounting_documents where organization_id = $1 and number = '777'", [org]))).toBe(1);
      expect(await asAdmin((q) => count(q, "select 1 from app.invoice_issue_requests where id = $1 and status = 'unrecorded' and provider_document_id = 'fake_doc_dup'", [r.request_id]))).toBe(1);
    });

    it("an accepted quote is a source; the document names it", async () => {
      const quote = await asAdmin(async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'הצעה', $2, $3) returning id", [org, deal, person])).id);
      expect((await pgError(begin(owner, randomUUID(), "quote", quote))).hint).toBe("invoice:source");
      await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [quote]));
      const r = await begin(owner, randomUUID(), "quote", quote);
      const done = await work(r.request_id as string);
      expect(done.status).toBe("issued");
      expect(await asAdmin((q) => count(q, "select 1 from public.accounting_documents where id = $1 and quote_id = $2", [done.document_id, quote]))).toBe(1);
    });

    it("a business whose VAT status is not set cannot issue", async () => {
      await asAdmin((q) => q("update public.org_document_settings set vat_status = null where organization_id = $1", [org]));
      expect((await pgError(begin(owner, randomUUID(), "contact", person))).hint).toBe("invoice:vat_unknown");
      await asAdmin((q) => q("update public.org_document_settings set vat_status = 'licensed' where organization_id = $1", [org]));
    });

    it("the fake is refused at begin and by the worker while app.settings invoice_provider_fake is not 'on'", async () => {
      const r = await begin(owner, randomUUID(), "contact", person);
      await asAdmin((q) => q("update app.settings set value = '' where key = 'invoice_provider_fake'"));
      try {
        expect((await pgError(begin(owner, randomUUID(), "deal", deal))).hint).toBe("invoice:provider");
        // the worker's first try asks nothing of the provider: the request ends failed
        expect(await work(r.request_id as string)).toMatchObject({ status: "failed", code: "invoice:provider", refused: "invoice:provider" });
      } finally {
        await asAdmin((q) => q("update app.settings set value = 'on' where key = 'invoice_provider_fake'"));
      }
    });

    it("an issuer who lost the right still gets their request issued; a business that became read-only keeps it unrecorded", async () => {
      const r = await begin(issuer, randomUUID(), "deal", deal);
      await run(owner, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, issuer.id, []]));
      try {
        expect((await pgError(begin(issuer, randomUUID(), "contact", person))).code).toBe("42501");
        const done = await work(r.request_id as string);
        expect(done.status).toBe("issued");
      } finally {
        await run(owner, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, issuer.id, ["issue_documents"]]));
      }
      // read-only after the provider was asked: the document stays on the request
      const pending = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "proforma" }));
      const out = result();
      try {
        const done = await work(pending.request_id as string, out, () => asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org])));
        expect(done).toMatchObject({ status: "unrecorded", number: out.number, code: "org_not_writable" });
        expect(await asAdmin((q) => count(q, "select 1 from app.invoice_issue_requests where id = $1 and provider_document_id = $2", [pending.request_id, out.provider_document_id]))).toBe(1);
        // the provider's document the business could not record is told (its number only)
        const told = await asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.notifications where organization_id = $1 and title = 'מסמך הופק אצל ספק החשבוניות ולא נרשם' and body like $2", [org, `%${out.number}%העסק לא יכול לרשום%`])).rows.map((x) => x.user_id).sort());
        expect(told).toEqual([owner.id, admin.id].sort());
      } finally {
        await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
      }
      // read-only before the provider was asked: nothing is asked, the request fails
      const before = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
      try {
        expect(await work(before.request_id as string)).toMatchObject({ status: "failed", code: "org_not_writable" });
      } finally {
        await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
      }
    });

    it("a request whose requester is no longer a member fails without asking the provider", async () => {
      const r = await begin(issuer, randomUUID(), "contact", person);
      await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, issuer.id]));
      try {
        expect(await work(r.request_id as string)).toMatchObject({ status: "failed", code: "requester_gone" });
      } finally {
        await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, issuer.id]));
        await run(owner, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, issuer.id, ["issue_documents"]]));
      }
    });

    it("owners and admins see and close anyone's open request; others see and close only their own", async () => {
      const r = await begin(issuer, randomUUID(), "deal", deal);
      const list = (u: U) => run(u, async (q) => (await one<{ r: { id: string; mine: boolean }[] }>(q, "select public.invoice_issue_requests_open($1) as r", [org])).r);
      expect((await list(admin)).find((x) => x.id === r.request_id)).toMatchObject({ mine: false });
      expect((await list(issuer)).find((x) => x.id === r.request_id)).toMatchObject({ mine: true });
      expect((await list(manager)).some((x) => x.id === r.request_id)).toBe(false);
      expect((await pgError(list(outsider))).code).toBe("42501");
      const close = (u: U) => run(u, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_issue_close($1, $2) as r", [org, r.request_id])).r);
      expect((await pgError(close(manager))).hint).toBe("invoice:request");
      expect(await close(admin)).toEqual({ status: "unrecorded", code: "closed" });
      expect(await asAdmin((q) => count(q, "select 1 from app.invoice_issue_requests where id = $1 and closed_by = $2", [r.request_id, admin.id]))).toBe(1);
      expect(await work(r.request_id as string)).toMatchObject({ status: "unrecorded", code: "closed" });
    });

    it("a request pending for more than a day is marked stale by the sweep, never deleted", async () => {
      const key = randomUUID();
      const r = await begin(owner, key, "contact", person);
      await asAdmin((q) => q("update app.invoice_issue_requests set created_at = now() - interval '25 hours' where id = $1", [r.request_id]));
      expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select app.invoice_issue_mark_stale() as n")).n)).toBeGreaterThanOrEqual(1);
      expect(await begin(owner, key, "contact", person)).toMatchObject({ status: "stale", request_id: r.request_id });
      expect(await work(r.request_id as string)).toMatchObject({ status: "stale", code: "stale" });
    });

    it("a business that charges no VAT issues no tax invoice or tax invoice-receipt", async () => {
      await asAdmin((q) => q("update public.org_document_settings set vat_status = 'exempt' where organization_id = $1", [org]));
      try {
        for (const type of ["tax_invoice", "tax_invoice_receipt"]) {
          expect((await pgError(begin(owner, randomUUID(), "contact", person, doc({ doc_type: type })))).hint, type).toBe("invoice:type_exempt");
        }
        expect((await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "receipt" }))).status).toBe("pending");
      } finally {
        await asAdmin((q) => q("update public.org_document_settings set vat_status = 'licensed' where organization_id = $1", [org]));
      }
    });

    it("a receipt keeps no VAT split: its amount is the money received", async () => {
      const r = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      // a licensed business: the typed amounts are the money received, no VAT added (2 x 100.00 + 40.00)
      expect((r.request as { totals: Record<string, number> }).totals).toMatchObject({ total_agorot: 24000, net_agorot: 24000, vat_agorot: 0, rate_bp: 0 });
      const done = await work(r.request_id as string);
      expect(done.status).toBe("issued");
      const row = await asAdmin((q) => one<Record<string, unknown>>(q, "select amount_agorot, net_agorot, vat_agorot, vat_rate_bp, allocation_number from public.accounting_documents where id = $1", [done.document_id]));
      expect(row).toEqual({
        amount_agorot: String((r.request as { totals: Record<string, number> }).totals.total_agorot),
        net_agorot: null,
        vat_agorot: null,
        vat_rate_bp: null,
        allocation_number: null,
      });
    });

    it("a reload within 15 minutes reaches the person's pending request for the same source and type", async () => {
      const first = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "proforma" }));
      const again = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "proforma", lines: [lines[0]] }));
      expect(again).toMatchObject({ status: "pending", request_id: first.request_id, reused: true });
      expect(again.request).toEqual(first.request);
      // another type, or another person, is a new request
      const other = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      expect(other.request_id).not.toBe(first.request_id);
      expect((await begin(admin, randomUUID(), "contact", person, doc({ doc_type: "proforma" }))).request_id).not.toBe(first.request_id);
      // after 15 minutes, a new one
      await asAdmin((q) => q("update app.invoice_issue_requests set created_at = now() - interval '16 minutes' where id = $1", [first.request_id]));
      expect((await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "proforma" }))).request_id).not.toBe(first.request_id);
    });

    it("the audit entries of an issued document and its lines name the issuer", async () => {
      const r = await begin(issuer, randomUUID(), "deal", deal);
      const done = await work(r.request_id as string);
      const actors = await asAdmin(async (q) =>
        (
          await q<{ entity_type: string; actor_id: string | null }>(
            "select entity_type, actor_id from public.audit_log where organization_id = $1 and (entity_id = $2 or entity_id in (select id from public.accounting_document_lines where document_id = $2))",
            [org, done.document_id],
          )
        ).rows,
      );
      expect(actors.filter((a) => a.entity_type === "accounting_documents").length).toBeGreaterThanOrEqual(1);
      expect(actors.filter((a) => a.entity_type === "accounting_document_lines").length).toBe(2);
      expect(actors.every((a) => a.actor_id === issuer.id)).toBe(true);
    });

    it("a malformed flag answers invoice:lines", async () => {
      expect((await pgError(begin(owner, randomUUID(), "contact", person, doc({ prices_include_vat: "maybe" })))).hint).toBe("invoice:lines");
      expect((await pgError(begin(owner, randomUUID(), "contact", person, doc({ lines: [{ ...lines[0], vat_exempt: "x" }] })))).hint).toBe("invoice:lines");
      expect((await pgError(begin(owner, randomUUID(), "contact", person, doc({ lines: ["x"] })))).hint).toBe("invoice:lines");
    });

    it("a numbered order is a source; the document names it", async () => {
      const wonDeal = await run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'התקנה', $2, $3, $4, $5) returning id", [org, pipelineId, wonStageId, person, owner.id])).id,
      );
      await run(owner, (q) => q("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot, quantity) values ($1, $2, 'התקנה', 50000, 1)", [org, wonDeal]));
      const order = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.order_from_deal($1, $2) as id", [org, wonDeal])).id);
      const r = await begin(owner, randomUUID(), "order", order);
      const done = await work(r.request_id as string);
      expect(done.status).toBe("issued");
      expect(await asAdmin((q) => count(q, "select 1 from public.accounting_documents where id = $1 and order_id = $2 and deal_id = $3", [done.document_id, order, wonDeal]))).toBe(1);
    });

    it("a provider document recorded after the business lost the documents key is told, never lost", async () => {
      const r = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      const out = result();
      const keys = '{"documents": true, "granular_permissions": true, "quotes": true, "orders": true}';
      try {
        const done = await work(r.request_id as string, out, () =>
          asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"documents\": false, \"granular_permissions\": true, \"quotes\": true, \"orders\": true}' where organization_id = $1", [org])),
        );
        expect(done).toMatchObject({ status: "unrecorded", code: "feature:documents", number: out.number });
      } finally {
        await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, keys]));
      }
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and user_id = $2 and body like $3", [org, admin.id, `%${out.number}%העסק לא יכול לרשום%`]))).toBe(1);
    });

    it("a cancelled order is no source (lead's decision)", async () => {
      const wonDeal = await run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'בוטלה', $2, $3, $4, $5) returning id", [org, pipelineId, wonStageId, person, owner.id])).id,
      );
      await run(owner, (q) => q("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot, quantity) values ($1, $2, 'שירות', 20000, 1)", [org, wonDeal]));
      const order = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.order_from_deal($1, $2) as id", [org, wonDeal])).id);
      await run(owner, (q) => q("update public.orders set status = 'cancelled' where organization_id = $1 and id = $2", [org, order]));
      expect((await pgError(begin(owner, randomUUID(), "order", order))).hint).toBe("invoice:order_cancelled");
      expect((await pgError(begin(owner, randomUUID(), "order", order, doc({ doc_type: "receipt" })))).hint).toBe("invoice:order_cancelled");
      expect((await pgError(run(owner, (q) => q("select public.invoice_issue_customer($1, 'order', $2)", [org, order])))).hint).toBe("invoice:order_cancelled");
    });

    it("an issuer with 'own' visibility cannot issue from another person's deal", async () => {
      await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
      try {
        expect((await pgError(begin(issuer, randomUUID(), "deal", deal))).hint).toBe("invoice:source");
      } finally {
        await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
      }
    });

    it("the provider's refusal ends the request failed; a retryable failure waits, then ends unrecorded on the last try", async () => {
      const refused = await begin(owner, randomUUID(), "contact", person);
      const job = await claimJob(refused.request_id as string);
      expect((await claimOf(job)).request_id).toBe(refused.request_id);
      expect(await record(job, { ok: false, code: "bad_details", final: true })).toEqual({ status: "failed", code: "bad_details" });
      await asService((q) => q("select public.finish_job($1, $2, false, 'refused', true)", [job.id, job.lease]));
      // a refusal tells no one and is not listed
      expect(await toldCheck(refused.request_id as string)).toEqual([]);
      expect((await listed(admin)).find((x) => x.id === refused.request_id)).toBeUndefined();

      const busy = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      const first = await claimJob(busy.request_id as string);
      await claimOf(first);
      expect(await record(first, { ok: false, code: "timeout", final: false })).toEqual({ status: "pending", code: "timeout" });
      // the queue's last try
      await asAdmin((q) => q("update app.jobs set attempts = app.job_max_attempts() where id = $1", [first.id]));
      expect(await record(first, { ok: false, code: "timeout", final: false })).toEqual({ status: "unrecorded", code: "retries_spent" });
      // a timeout may still have issued it: the people are told to check, and the request is listed until someone closes it
      expect(await toldCheck(busy.request_id as string)).toEqual([owner.id, admin.id].sort());
      expect((await listed(admin)).find((x) => x.id === busy.request_id)).toMatchObject({ status: "check", code: "retries_spent" });
      expect((await listed(issuer)).find((x) => x.id === busy.request_id)).toBeUndefined();
      expect((await run(owner, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_issue_close($1, $2) as r", [org, busy.request_id])).r))).toEqual({ status: "unrecorded", code: "checked" });
      expect((await listed(admin)).find((x) => x.id === busy.request_id)).toBeUndefined();
    });

    it("a pending request whose job died is ended unrecorded by the sweep", async () => {
      const r = await begin(owner, randomUUID(), "contact", person);
      await asAdmin((q) => q("update app.jobs set status = 'dead', finished_at = now() where id = (select job_id from app.invoice_issue_requests where id = $1)", [r.request_id]));
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await requestRow(r.request_id as string)).toMatchObject({ status: "unrecorded", code: "job_dead" });
      expect(await toldCheck(r.request_id as string)).toEqual([owner.id, admin.id].sort());
      expect((await listed(owner)).find((x) => x.id === r.request_id)).toMatchObject({ status: "check", code: "job_dead" });
      // swept once: a second sweep tells no one again
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await toldCheck(r.request_id as string)).toEqual([owner.id, admin.id].sort());
    });

    it("a pending request whose last try's lease ran out (job dead) is told to check at the provider, even when over a day old", async () => {
      const r = await begin(issuer, randomUUID(), "contact", person, doc({ doc_type: "proforma" }));
      const since = (await asAdmin((q) => one<{ t: string }>(q, "select now()::text as t"))).t;
      const job = await claimJob(r.request_id as string);
      await claimOf(job);
      await asAdmin((q) => q("update app.jobs set status = 'dead', lease_id = null, locked_until = null, finished_at = now() where id = $1", [job.id]));
      await asAdmin((q) => q("update app.invoice_issue_requests set created_at = now() - interval '25 hours' where id = $1", [r.request_id]));
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await requestRow(r.request_id as string)).toMatchObject({ status: "unrecorded", code: "job_dead" });
      expect(await toldCheck(r.request_id as string, since)).toEqual([owner.id, admin.id, issuer.id].sort());
      expect((await listed(issuer)).find((x) => x.id === r.request_id)).toMatchObject({ status: "check" });
    });

    it("a late lookup that found nothing stays final: the sweep never tells about it", async () => {
      const id = await closeAfterFailedTry(issuer, doc());
      const job = await claimJob(id);
      await claimOf(job);
      await record(job, { ok: false, code: "not_at_provider", final: true });
      await asService((q) => q("select public.finish_job($1, $2, false, 'not_at_provider', true)", [job.id, job.lease]));
      await asAdmin((q) => q("update app.jobs set status = 'refused' where id = $1 and status <> 'refused'", [job.id]));
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await requestRow(id)).toMatchObject({ status: "unrecorded", code: "closed" });
      expect(await toldCheck(id)).toEqual([]);
    });

    it("a late lookup refused for any other reason than not_at_provider (a rotated key) tells the people and is listed", async () => {
      const id = await closeAfterFailedTry(issuer, doc({ doc_type: "receipt" }));
      const job = await claimJob(id);
      expect(await claimOf(job)).toMatchObject({ late: true });
      expect(await record(job, { ok: false, code: "auth", final: true })).toEqual({ status: "unrecorded", code: "check_provider" });
      await asService((q) => q("select public.finish_job($1, $2, false, 'auth', true)", [job.id, job.lease]));
      expect(await toldCheck(id)).toEqual([owner.id, admin.id, issuer.id].sort());
      expect((await listed(issuer)).find((x) => x.id === id)).toMatchObject({ status: "check", code: "check_provider" });
      // final: a later sweep tells no one again
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await toldCheck(id)).toEqual([owner.id, admin.id, issuer.id].sort());
    });

    it("a final refusal after an earlier try (provider_changed) is kept unrecorded, told and listed; on the first try it just fails", async () => {
      const r = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "proforma" }));
      const first = await claimJob(r.request_id as string);
      await claimOf(first);
      await record(first, { ok: false, code: "timeout", final: false });
      await asService((q) => q("select public.finish_job($1, $2, false, 'timeout', false)", [first.id, first.lease]));
      await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [first.id]));
      const job = await claimJob(r.request_id as string);
      expect((await claimOf(job)).request_id).toBe(r.request_id);
      expect(await record(job, { ok: false, code: "provider_changed", final: true })).toEqual({ status: "unrecorded", code: "provider_changed" });
      await asService((q) => q("select public.finish_job($1, $2, false, 'provider_changed', true)", [job.id, job.lease]));
      expect(await toldCheck(r.request_id as string)).toEqual([owner.id, admin.id].sort());
      expect((await listed(admin)).find((x) => x.id === r.request_id)).toMatchObject({ status: "check", code: "provider_changed" });

      const once = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      const only = await claimJob(once.request_id as string);
      await claimOf(only);
      expect(await record(only, { ok: false, code: "provider_changed", final: true })).toEqual({ status: "failed", code: "provider_changed" });
      await asService((q) => q("select public.finish_job($1, $2, false, 'provider_changed', true)", [only.id, only.lease]));
      expect(await toldCheck(once.request_id as string)).toEqual([]);
      expect((await listed(admin)).find((x) => x.id === once.request_id)).toBeUndefined();
    });

    it("a pending request whose job was refused on its first try just fails, no alarm; refused after an earlier try is told", async () => {
      const r = await begin(owner, randomUUID(), "contact", person);
      await asAdmin((q) => q("update app.jobs set status = 'refused', attempts = 1, finished_at = now() where id = (select job_id from app.invoice_issue_requests where id = $1)", [r.request_id]));
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await requestRow(r.request_id as string)).toMatchObject({ status: "failed", code: "job_refused" });
      expect(await toldCheck(r.request_id as string)).toEqual([]);
      expect((await listed(owner)).find((x) => x.id === r.request_id)).toBeUndefined();

      const later = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      await asAdmin((q) => q("update app.jobs set status = 'refused', attempts = 2, finished_at = now() where id = (select job_id from app.invoice_issue_requests where id = $1)", [later.request_id]));
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await requestRow(later.request_id as string)).toMatchObject({ status: "unrecorded", code: "job_dead" });
      expect(await toldCheck(later.request_id as string)).toEqual([owner.id, admin.id].sort());
    });

    it("an order cancelled after begin is refused by the claim: nothing is sent, and on the first try nobody is alarmed", async () => {
      const wonDeal = await run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'בוטלה אחר כך', $2, $3, $4, $5) returning id", [org, pipelineId, wonStageId, person, owner.id])).id,
      );
      await run(owner, (q) => q("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot, quantity) values ($1, $2, 'שירות', 30000, 1)", [org, wonDeal]));
      const order = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.order_from_deal($1, $2) as id", [org, wonDeal])).id);
      const r = await begin(owner, randomUUID(), "order", order);
      await run(owner, (q) => q("update public.orders set status = 'cancelled' where organization_id = $1 and id = $2", [org, order]));
      expect(await work(r.request_id as string)).toMatchObject({ refused: "invoice:order_cancelled", status: "failed", code: "invoice:order_cancelled" });
      expect(await toldCheck(r.request_id as string)).toEqual([]);
      expect(await asAdmin((q) => count(q, "select 1 from public.accounting_documents where organization_id = $1 and order_id = $2", [org, order]))).toBe(0);
    });

    it("a closed or stale request whose late lookup never answered (its job died) is swept, told once and listed", async () => {
      const id = await closeAfterFailedTry(issuer, doc({ doc_type: "receipt" }));
      const job = await claimJob(id);
      expect(await claimOf(job)).toMatchObject({ late: true });
      // the lease runs out on the queue's last try: the job dies without a record
      await asAdmin((q) => q("update app.jobs set status = 'dead', lease_id = null, locked_until = null, finished_at = now() where id = $1", [job.id]));
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await requestRow(id)).toMatchObject({ status: "unrecorded", code: "check_provider", document_id: null });
      expect(await toldCheck(id)).toEqual([owner.id, admin.id, issuer.id].sort());
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await toldCheck(id)).toEqual([owner.id, admin.id, issuer.id].sort());
      expect((await listed(admin)).find((x) => x.id === id)).toMatchObject({ status: "check", code: "check_provider" });

      // marked stale (not closed) the same way
      const r = await begin(issuer, randomUUID(), "contact", person);
      const first = await claimJob(r.request_id as string);
      await claimOf(first);
      await record(first, { ok: false, code: "throttled", final: false });
      await asService((q) => q("select public.finish_job($1, $2, false, 'throttled', false)", [first.id, first.lease]));
      await asAdmin((q) => q("update app.invoice_issue_requests set status = 'stale', error_code = 'stale', finished_at = now() where id = $1", [r.request_id]));
      await asAdmin((q) => q("update app.jobs set status = 'dead', attempts = 2, finished_at = now() where id = $1", [first.id]));
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await requestRow(r.request_id as string)).toMatchObject({ status: "unrecorded", code: "check_provider" });
      expect(await toldCheck(r.request_id as string)).toEqual([owner.id, admin.id, issuer.id].sort());
    });

    it("a request closed before any try, whose job then ended, is never told about", async () => {
      const r = await begin(issuer, randomUUID(), "contact", person);
      await run(issuer, (q) => q("select public.invoice_issue_close($1, $2)", [org, r.request_id]));
      await asAdmin((q) => q("update app.jobs set status = 'refused', attempts = 1, finished_at = now() where id = (select job_id from app.invoice_issue_requests where id = $1)", [r.request_id]));
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await requestRow(r.request_id as string)).toMatchObject({ status: "unrecorded", code: "closed" });
      expect(await toldCheck(r.request_id as string)).toEqual([]);
      expect((await listed(admin)).find((x) => x.id === r.request_id)).toBeUndefined();
    });

    it("the page reads its request: the requester and owners/admins, no one else", async () => {
      const r = await begin(issuer, randomUUID(), "contact", person);
      const state = (u: U) => run(u, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_issue_state($1, $2) as r", [org, r.request_id])).r);
      expect(await state(issuer)).toMatchObject({ status: "pending", source_kind: "contact", source_id: person, doc_type: "tax_invoice" });
      expect((await state(admin)).status).toBe("pending");
      expect((await pgError(state(manager))).hint).toBe("invoice:request");
      expect((await pgError(state(outsider))).code).toBe("42501");
      const done = await work(r.request_id as string);
      expect(await state(issuer)).toMatchObject({ status: "issued", document_id: done.document_id, number: done.number });
    });

    // owner (398) א: the worker's path and the person's begin, pinned by md5(pg_get_functiondef) without carriage returns (the
    // form the lead compares on the hosted project: body, security definer, settings, arguments). A change needs a fresh independent review against answer (55)'s conditions (ids only in the queue; the
    // service key calls only the claim and the record; no person records a provider's answer).
    it("the invoice.issue functions are the reviewed ones", async () => {
      const rows = await asAdmin(
        async (q) =>
          (
            await q<{ name: string; md5: string }>(
              `select n.nspname || '.' || p.proname as name,
                      md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as md5
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where (n.nspname, p.proname) in (('public', 'invoice_issue_claim'), ('public', 'invoice_issue_record'),
                                                 ('app', 'invoice_issue_open'), ('app', 'invoice_provider_usable'),
                                                 ('app', 'invoice_issue_mark_stale'), ('app', 'invoice_provider_of'),
                                                 ('app', 'invoice_issuer_check'), ('app', 'invoice_source'),
                                                 ('app', 'invoice_customer'), ('public', 'invoice_issue_begin'),
                                                 ('public', 'invoice_issue_close'), ('app', 'invoice_issue_requests_erase'),
                                                 ('app', 'invoice_issue_payload_erased'), ('app', 'invoice_issue_late_notice'),
                                                 ('app', 'merge_invoice_issue_requests'), ('app', 'job_payload_ok'),
                                                 ('app', 'job_kinds'), ('public', 'invoice_issue_state'),
                                                 ('public', 'invoice_issue_requests_open'), ('public', 'invoice_provider_connect'),
                                                 ('public', 'invoice_provider_disconnect'), ('public', 'invoice_provider_check_recorded'),
                                                 ('app', 'can_issue_documents'), ('app', 'invoice_provider_customer_of'),
                                                 ('app', 'invoice_provider_customer_keep'), ('app', 'invoice_customer_details_hash'),
                                                 ('app', 'can_issue_credits'), ('app', 'invoice_credit_check'),
                                                 ('app', 'invoice_credit_room_of'), ('app', 'invoice_credit_open'),
                                                 ('public', 'invoice_credit_begin'), ('public', 'invoice_credit_room'),
                                                 ('public', 'invoice_credit_release'), ('app', 'invoice_credit_reserves'),
                                                 ('app', 'invoice_credit_lines'), ('app', 'accounting_documents_credit_lock'),
                                                 ('app', 'invoice_product_details'), ('app', 'invoice_provider_products_of'),
                                                 ('app', 'invoice_provider_products_keep'), ('app', 'accounting_documents_credit_reason'),
                                                 ('app', 'accounting_document_lines_credit_reason_erase'),
                                                 ('app', 'audit_log_credit_reason_erase'), ('app', 'invoice_credit_hand_room'))
                order by 1`,
            )
          ).rows,
      );
      expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual(REVIEWED_MD5);
    });

    it("a request cannot be closed, or swept stale, while the provider is being asked; one ended before the answer still records it", async () => {
      const r = await begin(issuer, randomUUID(), "contact", person);
      const job = await claimJob(r.request_id as string);
      expect((await claimOf(job)).request_id).toBe(r.request_id);
      const close = () => run(admin, (q) => q("select public.invoice_issue_close($1, $2)", [org, r.request_id]));
      expect((await pgError(close())).hint).toBe("invoice:busy");
      // marked stale while the provider is being asked: still busy
      await asAdmin((q) => q("update app.invoice_issue_requests set status = 'stale', error_code = 'stale' where id = $1", [r.request_id]));
      expect((await pgError(close())).hint).toBe("invoice:busy");
      await asAdmin((q) => q("update app.invoice_issue_requests set status = 'pending', error_code = null where id = $1", [r.request_id]));
      await asAdmin((q) => q("update app.invoice_issue_requests set created_at = now() - interval '25 hours' where id = $1", [r.request_id]));
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect((await requestRow(r.request_id as string)).status).toBe("pending");
      // ended by an older path while the provider answered: the document is still recorded
      await asAdmin((q) => q("update app.invoice_issue_requests set status = 'unrecorded', error_code = 'closed', finished_at = now() where id = $1", [r.request_id]));
      const done = await record(job, { ok: true, ...result() });
      expect(done.status).toBe("issued");
      expect(await requestRow(r.request_id as string)).toMatchObject({ status: "issued", document_id: done.document_id });
      await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
    });

    it("a closed request the provider issued anyway, in a business that can no longer record, keeps the number and tells the people", async () => {
      const r = await begin(issuer, randomUUID(), "contact", person, doc({ doc_type: "proforma" }));
      const job = await claimJob(r.request_id as string);
      await claimOf(job);
      await asAdmin((q) => q("update app.invoice_issue_requests set status = 'stale', error_code = 'stale', finished_at = now() where id = $1", [r.request_id]));
      const out = result();
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
      try {
        expect(await record(job, { ok: true, ...out })).toMatchObject({ status: "unrecorded", code: "issued_after_close", number: out.number });
      } finally {
        await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
      }
      expect(await asAdmin((q) => count(q, "select 1 from app.invoice_issue_requests where id = $1 and provider_document_id = $2", [r.request_id, out.provider_document_id]))).toBe(1);
      const told = await asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.notifications where organization_id = $1 and title = 'מסמך הופק אצל ספק החשבוניות ולא נרשם' and body like $2", [org, `%${out.number}%`])).rows.map((x) => x.user_id).sort());
      expect(told).toEqual([owner.id, admin.id, issuer.id].sort());
      await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
    });

    it("a deadlock while recording is raised, so the queue tries again", async () => {
      const src = await asAdmin(async (q) => (await one<{ s: string }>(q, "select prosrc as s from pg_proc where oid = 'public.invoice_issue_record(uuid, uuid, jsonb)'::regprocedure")).s);
      expect(src).toMatch(/if v_state in \('40P01', '40001', '55P03'\) then\s+raise;/);
    });

    it("the source's ids must be of the business, even when the open step is called directly", async () => {
      const otherContact = await run(outsider, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'זר', $2) returning id", [otherOrg, outsider.id])).id);
      const source = { kind: "contact", id: otherContact, contact_id: otherContact, deal_id: null, company_id: null, order_id: null, quote_id: null };
      expect((await pgError(run(owner, (q) => q("select app.invoice_issue_open($1, $2, $3, $4)", [org, randomUUID(), JSON.stringify(source), JSON.stringify(doc())])))).hint).toBe("invoice:source");
      expect((await pgError(run(outsider, (q) => q("select app.invoice_customer($1, $2, null)", [org, person])))).code).toBe("42501");
    });

    it("privacy: an erasure of the source empties the request's customer and line texts; so do 12 months after it ended", async () => {
      const r = await begin(owner, randomUUID(), "deal", deal);
      await asAdmin((q) => q("insert into public.audit_log (organization_id, action, entity_type, entity_id) values ($1, 'erase', 'contacts', $2)", [org, person]));
      const payload = (await asAdmin((q) => one<{ p: { customer: unknown; lines: { description: string }[] } }>(q, "select payload as p from app.invoice_issue_requests where id = $1", [r.request_id]))).p;
      expect(payload.customer).toEqual({ erased: true });
      expect(payload.lines.every((l) => l.description === "הפריט נמחק (מחיקת פרטיות)")).toBe(true);

      const old = await begin(owner, randomUUID(), "contact", businessContact, doc({ doc_type: "receipt" }));
      await asAdmin((q) => q("update app.invoice_issue_requests set status = 'failed', finished_at = now() - interval '13 months' where id = $1", [old.request_id]));
      await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
      expect(await asAdmin((q) => count(q, "select 1 from app.invoice_issue_requests where id = $1 and customer_erased_at is not null and payload -> 'customer' = '{\"erased\": true}'::jsonb", [old.request_id]))).toBe(1);
    });

    it("a timeout, then a close: the next try asks the provider again with the same key and records the document", async () => {
      const r = await begin(issuer, randomUUID(), "contact", person);
      const first = await claimJob(r.request_id as string);
      await claimOf(first);
      expect(await record(first, { ok: false, code: "timeout", final: false })).toMatchObject({ status: "pending" });
      await asService((q) => q("select public.finish_job($1, $2, false, 'timeout', false)", [first.id, first.lease]));
      expect(await run(admin, async (q) => (await one<{ r: unknown }>(q, "select public.invoice_issue_close($1, $2) as r", [org, r.request_id])).r)).toEqual({ status: "unrecorded", code: "closed" });
      await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [first.id]));
      const done = await work(r.request_id as string);
      expect(done.status).toBe("issued");
      expect(await requestRow(r.request_id as string)).toMatchObject({ status: "issued", document_id: done.document_id });
    });

    it("a lease that ran out mid-call, then a close: the next try records it late", async () => {
      const r = await begin(issuer, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      const first = await claimJob(r.request_id as string);
      await claimOf(first);
      await asAdmin((q) => q("update app.jobs set locked_until = now() - interval '1 second' where id = $1", [first.id]));
      await run(admin, (q) => q("select public.invoice_issue_close($1, $2)", [org, r.request_id]));
      const job = await claimJob(r.request_id as string);
      expect(await claimOf(job)).toMatchObject({ request_id: r.request_id, late: true });
      expect((await record(job, { ok: true, ...result() })).status).toBe("issued");
      await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
    });

    it("a request closed before any try reached the provider is never sent", async () => {
      const r = await begin(issuer, randomUUID(), "contact", person);
      await run(issuer, (q) => q("select public.invoice_issue_close($1, $2)", [org, r.request_id]));
      expect(await work(r.request_id as string)).toMatchObject({ refused: "finished", status: "unrecorded", code: "closed" });
      expect((await requestRow(r.request_id as string)).document_id).toBeNull();
    });

    it("a request whose customer was erased is never sent", async () => {
      const contact = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נמחק', $2) returning id", [org, owner.id])).id);
      const r = await begin(owner, randomUUID(), "contact", contact);
      await asAdmin((q) => q("insert into public.audit_log (organization_id, action, entity_type, entity_id) values ($1, 'erase', 'contacts', $2)", [org, contact]));
      expect(await work(r.request_id as string)).toMatchObject({ refused: "customer_erased", status: "failed", code: "customer_erased" });
    });

    it("a merge moves the duplicate's requests, so the kept contact's erasure reaches them", async () => {
      const [dup, kept] = await run(owner, async (q) => [
        (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'כפול', $2) returning id", [org, owner.id])).id,
        (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נשאר', $2) returning id", [org, owner.id])).id,
      ]);
      const r = await begin(owner, randomUUID(), "contact", dup);
      await asAdmin((q) => q("insert into public.activities (organization_id, type, body, metadata, contact_id) values ($1, 'system', 'מוזג', $2, $3)", [org, JSON.stringify({ merged_id: dup }), kept]));
      const source = (await asAdmin((q) => one<{ s: Record<string, string> }>(q, "select source as s from app.invoice_issue_requests where id = $1", [r.request_id]))).s;
      expect(source).toMatchObject({ kind: "contact", id: kept, contact_id: kept });
      const ref = (await asAdmin((q) => one<{ r: string }>(q, "select payload -> 'customer' ->> 'external_ref' as r from app.invoice_issue_requests where id = $1", [r.request_id]))).r;
      expect(ref).toBe(`contact:${kept}`);
      await asAdmin((q) => q("insert into public.audit_log (organization_id, action, entity_type, entity_id) values ($1, 'erase', 'contacts', $2)", [org, kept]));
      expect(await asAdmin((q) => count(q, "select 1 from app.invoice_issue_requests where id = $1 and customer_erased_at is not null", [r.request_id]))).toBe(1);
    });

    // a closed request whose job tried before: the next claim is late (the worker only LOOKS UP by the same key)
    const closeAfterFailedTry = async (u: U, d: Record<string, unknown>) => {
      const r = await begin(u, randomUUID(), "contact", person, d);
      const first = await claimJob(r.request_id as string);
      await claimOf(first);
      expect(await record(first, { ok: false, code: "throttled", final: false })).toMatchObject({ status: "pending" });
      await asService((q) => q("select public.finish_job($1, $2, false, 'throttled', false)", [first.id, first.lease]));
      await run(admin, (q) => q("select public.invoice_issue_close($1, $2)", [org, r.request_id]));
      await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [first.id]));
      return r.request_id as string;
    };

    it("a throttled try, then a close: the late lookup finds nothing and the closed request stays final", async () => {
      const id = await closeAfterFailedTry(issuer, doc());
      const job = await claimJob(id);
      expect(await claimOf(job)).toMatchObject({ request_id: id, late: true });
      expect(await record(job, { ok: false, code: "not_at_provider", final: true })).toEqual({ status: "unrecorded", code: "closed" });
      await asService((q) => q("select public.finish_job($1, $2, false, 'not_at_provider', true)", [job.id, job.lease]));
      expect(await requestRow(id)).toMatchObject({ status: "unrecorded", code: "closed", document_id: null });
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title like '%ספק החשבוניות%' and created_at > now() - interval '1 minute' and body like '%שנסגרה%' and body not like '%(מספר%'", [org]))).toBe(0);
    });

    it("a late lookup without an answer is tried again; on the last try the people are told to check at the provider", async () => {
      const id = await closeAfterFailedTry(issuer, doc({ doc_type: "proforma" }));
      const job = await claimJob(id);
      await claimOf(job);
      expect(await record(job, { ok: false, code: "timeout", final: false })).toEqual({ status: "pending", code: "timeout" });
      expect(await requestRow(id)).toMatchObject({ status: "unrecorded", code: "closed" });
      await asAdmin((q) => q("update app.jobs set attempts = app.job_max_attempts() where id = $1", [job.id]));
      expect(await record(job, { ok: false, code: "timeout", final: false })).toEqual({ status: "unrecorded", code: "check_provider" });
      expect(await toldCheck(id)).toEqual([owner.id, admin.id, issuer.id].sort());
      await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
    });

    it("a late claim is refused while the business cannot record", async () => {
      const id = await closeAfterFailedTry(owner, doc({ doc_type: "receipt" }));
      await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [org]));
      try {
        expect(await work(id)).toMatchObject({ refused: "org_not_writable", status: "unrecorded", code: "check_provider" });
      } finally {
        await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
      }
      // the lookup could not be made: the people are told (in a suspended business only the owner keeps notices), and the
      // request is final (a later claim answers finished)
      expect(await toldCheck(id)).toEqual([owner.id]);
      expect((await listed(owner)).find((x) => x.id === id)).toMatchObject({ status: "check", code: "check_provider" });
      // the other late refusals tell the same way
      const id2 = await closeAfterFailedTry(issuer, doc({ doc_type: "proforma" }));
      await run(admin, (q) => q("select public.invoice_provider_disconnect($1)", [org]));
      try {
        expect(await work(id2)).toMatchObject({ refused: "invoice:not_connected", status: "unrecorded", code: "check_provider" });
      } finally {
        await connect(admin);
      }
      expect(await toldCheck(id2)).toEqual([owner.id, admin.id, issuer.id].sort());
    });

    it("a refusal at the claim after an earlier try tells the people to check at the provider; on the first try it tells no one", async () => {
      const r = await begin(owner, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      const first = await claimJob(r.request_id as string);
      await claimOf(first);
      await record(first, { ok: false, code: "timeout", final: false });
      await asService((q) => q("select public.finish_job($1, $2, false, 'timeout', false)", [first.id, first.lease]));
      await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [first.id]));
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
      try {
        expect(await work(r.request_id as string)).toMatchObject({ refused: "org_not_writable", status: "unrecorded", code: "org_not_writable" });
      } finally {
        await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
      }
      expect(await toldCheck(r.request_id as string)).toEqual([owner.id, admin.id].sort());
      expect((await listed(owner)).find((x) => x.id === r.request_id)).toMatchObject({ status: "check", code: "org_not_writable" });
    });

    it("nothing is recorded in the name of someone who is no longer a member", async () => {
      const r = await begin(issuer, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      const job = await claimJob(r.request_id as string);
      await claimOf(job);
      await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, issuer.id]));
      const out = result();
      try {
        expect(await record(job, { ok: true, ...out })).toMatchObject({ status: "unrecorded", code: "requester_gone", number: out.number });
      } finally {
        await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, issuer.id]));
        await run(owner, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, issuer.id, ["issue_documents"]]));
      }
      expect(await asAdmin((q) => count(q, "select 1 from public.accounting_documents where organization_id = $1 and provider_document_id = $2", [org, out.provider_document_id]))).toBe(0);
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and user_id = $2 and body like $3", [org, owner.id, `%${out.number}%כבר לא חבר פעיל%`]))).toBe(1);
      await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
    });

    it("no API role reads the requests", async () => {
      for (const u of [owner, issuer]) {
        expect((await pgError(run(u, (q) => q("select 1 from app.invoice_issue_requests")))).code).toBe("42501");
      }
    });
  });

  // DOC-13 (migration invoice_provider_customers): the provider's customer id is kept per business, provider and customer,
  // with the hash of the details it was made with; the claim says whether it is still current
  describe("the customer at the provider (DOC-13)", () => {
    const kept = (contact: string) =>
      asAdmin((q) => q<Record<string, unknown>>("select provider, provider_customer_id, details_sha256 from app.invoice_provider_customers where organization_id = $1 and contact_id = $2", [org, contact]).then((r) => r.rows));
    const claimOnly = async (request: string) => {
      const job = await claimJob(request);
      const claim = await claimOf(job);
      return { job, claim };
    };

    it("nothing kept: the claim answers none; the id the worker got is kept, and the next claim reuses it while the details are the same", async () => {
      const first = await begin(issuer, randomUUID(), "contact", person);
      const a = await claimOnly(first.request_id as string);
      expect(a.claim.provider_customer ?? null).toBeNull();
      const done = await record(a.job, { ok: true, ...result(), provider_customer_id: "fake_customer_abc" });
      expect(done.status).toBe("issued");
      await asService((q) => q("select public.finish_job($1, $2, true)", [a.job.id, a.job.lease]));
      expect(await kept(person)).toEqual([expect.objectContaining({ provider: "fake", provider_customer_id: "fake_customer_abc" })]);

      const second = await begin(issuer, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      const b = await claimOnly(second.request_id as string);
      expect(b.claim.provider_customer).toEqual({ id: "fake_customer_abc", current: true });
      await record(b.job, { ok: true, ...result() });
      await asService((q) => q("select public.finish_job($1, $2, true)", [b.job.id, b.job.lease]));
      expect(await kept(person)).toHaveLength(1);

      // our details changed: still the same id, but not current, so the worker sends them again
      await run(owner, (q) => q("update public.contacts set email = 'dana.new@example.com' where id = $1", [person]));
      const third = await begin(issuer, randomUUID(), "contact", person, doc({ doc_type: "proforma" }));
      const c = await claimOnly(third.request_id as string);
      expect(c.claim.provider_customer).toEqual({ id: "fake_customer_abc", current: false });
      // a failed document still keeps the customer the provider made or updated
      expect((await record(c.job, { ok: false, code: "bad", final: true, provider_customer_id: "fake_customer_abc" })).status).toBe("failed");
      await asService((q) => q("select public.finish_job($1, $2, true)", [c.job.id, c.job.lease]));
      const after = await kept(person);
      expect(after).toHaveLength(1);
      const fourth = await begin(issuer, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
      const d = await claimOnly(fourth.request_id as string);
      expect(d.claim.provider_customer).toEqual({ id: "fake_customer_abc", current: true });
      await record(d.job, { ok: false, code: "bad", final: true });
      await asService((q) => q("select public.finish_job($1, $2, true)", [d.job.id, d.job.lease]));
    });

    it("a company customer is kept by the company; an id that is not a provider code is not kept", async () => {
      await run(owner, (q) => q("update public.companies set tax_id = '514713288', address_line = 'הברזל 3', city = 'תל אביב' where id = $1", [company]));
      const r = await begin(owner, randomUUID(), "deal", companyDeal);
      const job = await claimJob(r.request_id as string);
      await claimOf(job);
      await record(job, { ok: false, code: "x", final: false, provider_customer_id: "bad id with spaces" });
      expect(await asAdmin((q) => count(q, "select 1 from app.invoice_provider_customers where organization_id = $1 and company_id = $2", [org, company]))).toBe(0);
      await record(job, { ok: true, ...result(), provider_customer_id: "fake_customer_co" });
      await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
      // the customer of a deal with a company is its contact first (app.invoice_customer: contact:<id>)
      const ref = (r.request as { customer: { external_ref: string } }).customer.external_ref;
      const [kind, id] = ref.split(":");
      expect(await asAdmin((q) => count(q, `select 1 from app.invoice_provider_customers where organization_id = $1 and ${kind}_id = $2 and provider_customer_id = 'fake_customer_co'`, [org, id]))).toBe(1);
    });

    it("no person reads or writes the kept ids", async () => {
      for (const u of [owner, admin, issuer]) {
        expect((await pgError(run(u, (q) => q("select 1 from app.invoice_provider_customers")))).code).toBe("42501");
      }
      expect((await pgError(asService((q) => q("select 1 from app.invoice_provider_customers")))).code).toBe("42501");
    });

    // owner (410) ב: products the same way (a line keeps the product it came from)
    it("a line's product: the claim lists it with our details; the id the worker got is kept, current until our details change", async () => {
      const product = await run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.products (organization_id, name, sku, price_agorot) values ($1, 'מוצר בדיקה', 'SKU-1', 10000) returning id", [org])).id,
      );
      const withProduct = doc({ doc_type: "receipt", lines: [{ ...lines[0], product_id: product }, lines[1]] });
      const r = await begin(issuer, randomUUID(), "contact", person, withProduct);
      expect((r.request as { lines: Record<string, unknown>[] }).lines.map((l) => l.product_id ?? null)).toEqual([product, null]);
      const a = await claimOnly(r.request_id as string);
      expect(a.claim.provider_products).toEqual([
        { product_id: product, product: expect.objectContaining({ external_ref: `product:${product}`, name: "מוצר בדיקה", sku: "SKU-1", price_agorot: 10000, vat_exempt: false }), kept: null },
      ]);
      const done = await record(a.job, { ok: true, ...result(), provider_product_ids: { [product]: "fake_product_1", [randomUUID()]: "fake_product_x" } });
      await asService((q) => q("select public.finish_job($1, $2, true)", [a.job.id, a.job.lease]));
      // the recorded line names the product; only the request's own products are kept
      expect(await asAdmin((q) => count(q, "select 1 from public.accounting_document_lines where document_id = $1 and product_id = $2", [done.document_id, product]))).toBe(1);
      expect(await asAdmin((q) => count(q, "select 1 from app.invoice_provider_products where organization_id = $1", [org]))).toBe(1);

      const b = await claimOnly((await begin(issuer, randomUUID(), "contact", person, doc({ doc_type: "proforma", lines: [{ ...lines[0], product_id: product }] }))).request_id as string);
      expect((b.claim.provider_products as { kept: unknown }[])[0].kept).toEqual({ id: "fake_product_1", current: true });
      await record(b.job, { ok: false, code: "x", final: true });
      await asService((q) => q("select public.finish_job($1, $2, true)", [b.job.id, b.job.lease]));
      await run(owner, (q) => q("update public.products set price_agorot = 12000 where id = $1", [product]));
      const c = await claimOnly((await begin(issuer, randomUUID(), "contact", person, doc({ doc_type: "receipt", lines: [{ ...lines[0], product_id: product }] }))).request_id as string);
      expect((c.claim.provider_products as { kept: unknown }[])[0].kept).toEqual({ id: "fake_product_1", current: false });
      await record(c.job, { ok: false, code: "x", final: true });
      await asService((q) => q("select public.finish_job($1, $2, true)", [c.job.id, c.job.lease]));
      // another business's product is refused
      const foreign = await run(outsider, async (q) => (await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot) values ($1, 'זר', 100) returning id", [otherOrg])).id);
      expect((await pgError(begin(issuer, randomUUID(), "contact", person, doc({ lines: [{ ...lines[0], product_id: foreign }] })))).hint).toBe("invoice:lines");
    });

    it("the kept id goes with its contact when the contact is purged", async () => {
      const temp = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'זמני', $2) returning id", [org, owner.id])).id);
      const r = await begin(issuer, randomUUID(), "contact", temp, doc({ doc_type: "receipt" }));
      const job = await claimJob(r.request_id as string);
      await claimOf(job);
      await record(job, { ok: false, code: "x", final: true, provider_customer_id: "fake_customer_tmp" });
      await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
      expect(await kept(temp)).toHaveLength(1);
      await asAdmin((q) => q("delete from public.contacts where id = $1", [temp]));
      expect(await asAdmin((q) => count(q, "select 1 from app.invoice_provider_customers where provider_customer_id = 'fake_customer_tmp'"))).toBe(0);
    });
  });

  // DOC-14 (migration invoice_credit): a credit invoice through the provider, full or partial, only for owners, admins and
  // the `issue_credits` grant, always with a reason, never more than what is left; the same request path as DOC-07
  describe("credit invoices (DOC-14)", () => {
    let creditor: U, halfCreditor: U;
    const creditBegin = (u: U, documentId: string, credit: Record<string, unknown>, key = randomUUID()) =>
      run(u, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_credit_begin($1, $2, $3, $4) as r", [org, key, documentId, JSON.stringify(credit)])).r);
    const room = (u: U, documentId: string) =>
      run(u, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_credit_room($1, $2) as r", [org, documentId])).r);
    // a taxable-only original (two taxable lines); the default doc() mixes an exempt line in (owner (411) ב: line credits)
    const taxableLines = [
      { description: "שירות", quantity: 1, unit_price_agorot: 10000, discount_agorot: 0, vat_exempt: false },
      { description: "ייעוץ", quantity: 2, unit_price_agorot: 5000, discount_agorot: 0, vat_exempt: false },
    ];
    const taxableDoc = () => doc({ lines: taxableLines });
    const issued = async (d: Record<string, unknown> = taxableDoc()) => {
      const r = await begin(owner, randomUUID(), "deal", deal, d);
      const done = await work(r.request_id as string);
      expect(done.status).toBe("issued");
      return { id: done.document_id as string, request: r.request as { totals: Record<string, number> } };
    };
    const creditResult = () => ({ provider_document_id: `fake_doc_c${++seq}`, number: `7000${seq}`, allocation: { status: "not_needed" } });
    // the request's lines give exactly its totals through app.document_totals (what the provider prints is what is recorded)
    const expectLinesGiveTotals = async (request: unknown) => {
      const req = request as { lines: unknown[]; totals: Record<string, number | boolean> };
      const totals = await asAdmin(async (q) =>
        (await one<{ t: Record<string, number> }>(q, "select app.document_totals($1::jsonb, $2, $3) as t", [JSON.stringify(req.lines), req.totals.rate_bp, req.totals.prices_include_vat])).t,
      );
      expect({ net: Number(totals.net_total_agorot), vat: Number(totals.vat_agorot), total: Number(totals.total_agorot) }).toEqual({
        net: req.totals.net_agorot,
        vat: req.totals.vat_agorot,
        total: req.totals.total_agorot,
      });
    };
    const docRow = (id: unknown) =>
      asAdmin((q) => one<Record<string, unknown>>(q, "select doc_type, amount_agorot, net_agorot, vat_agorot, original_document_id, deal_id, contact_id, provider, created_by, allocation_number, allocation_error_code from public.accounting_documents where id = $1", [id]));

    beforeAll(async () => {
      creditor = await addMember(org, owner.id, "member", "inv-creditor");
      // owner (408) ד: a member credits only with both keys
      await run(owner, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, creditor.id, ["issue_documents", "issue_credits"]]));
      halfCreditor = await addMember(org, owner.id, "member", "inv-half-creditor");
      await run(owner, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, halfCreditor.id, ["issue_credits"]]));
    });

    it("owners and admins credit; anyone else needs both issue_documents and issue_credits (owner (408) ד)", async () => {
      const original = await issued();
      for (const u of [manager, member, issuer, halfCreditor, viewer, outsider]) {
        expect((await pgError(creditBegin(u, original.id, { reason: "טעות" }))).code, u.email).toBe("42501");
      }
      expect((await room(creditor, original.id)).creditable).toBe(true);
      const r = await creditBegin(creditor, original.id, { reason: "החזרה", amount_agorot: 100 });
      expect(r.status).toBe("pending");
      expect((await pgError(run(member, (q) => q("select public.invoice_credit_room($1, $2)", [org, original.id]))))).toMatchObject({ code: "42501" });
    });

    it("a reason is required (1..500, no control characters); an amount is whole agorot from 1 to what is left", async () => {
      const original = await issued();
      for (const reason of ["", "   ", "x".repeat(501), "a\u0007b", "\n\n", "a\u200fb", "a\u202eb", "a\ufeffb", "\u2028"]) {
        expect((await pgError(creditBegin(admin, original.id, { reason }))).hint).toBe("invoice_credit:reason");
      }
      expect((await pgError(creditBegin(admin, original.id, {}))).hint).toBe("invoice_credit:reason");
      // one line: line breaks and runs of white space fold into one space
      const folded = await creditBegin(admin, original.id, { reason: "  החזרה\n\nשל\u2028  סחורה ", amount_agorot: 1 });
      expect((folded.request as { reason: string }).reason).toBe("החזרה של סחורה");
      const total = original.request.totals.total_agorot;
      for (const amount_agorot of [0, -5, total + 1, "abc", 1.5]) {
        expect((await pgError(creditBegin(admin, original.id, { reason: "טעות", amount_agorot }))).hint, String(amount_agorot)).toBe("invoice_credit:amount");
      }
    });

    it("partial then full: the VAT is what the rate gives (never above), the lines give exactly the totals, nothing is left after", async () => {
      const original = await issued();
      const { total_agorot: total, vat_agorot: vat, net_agorot: net } = original.request.totals;
      const part = await creditBegin(admin, original.id, { reason: "הנחה בדיעבד", amount_agorot: 1000 });
      const partTotals = (part.request as { totals: Record<string, number> }).totals;
      const share = partTotals.vat_agorot;
      // what 18% gives 1,000 with VAT, never above it
      expect(share).toBeLessThanOrEqual(1000 - Math.round((1000 * 10000) / 11800));
      expect(share).toBeGreaterThanOrEqual(150);
      expect(partTotals).toMatchObject({ total_agorot: 1000, net_agorot: 1000 - share, rate_bp: 1800 });
      expect(part.request).toMatchObject({ doc_type: "credit_invoice", original_document_id: original.id, reason: "הנחה בדיעבד" });
      await expectLinesGiveTotals(part.request);
      // a pending credit already counts against what is left
      expect(await room(admin, original.id)).toMatchObject({ creditable: true, pending_agorot: 1000, left_agorot: total - 1000 });
      expect((await pgError(creditBegin(admin, original.id, { reason: "עוד", amount_agorot: total - 999 }))).hint).toBe("invoice_credit:amount");

      // the worker: no customer step for a credit, the credit invoice recorded with its original
      const job = await claimJob(part.request_id as string);
      const claim = await claimOf(job);
      expect(claim.provider_customer ?? null).toBeNull();
      expect((claim.request as Record<string, unknown>).original_provider_document_id).toBeTruthy();
      const done = await record(job, { ok: true, ...creditResult() });
      await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
      expect(done.status).toBe("issued");
      expect(await docRow(done.document_id)).toMatchObject({
        doc_type: "credit_invoice",
        amount_agorot: "1000",
        vat_agorot: String(share),
        original_document_id: original.id,
        deal_id: deal,
        contact_id: person,
        provider: "fake",
        created_by: admin.id,
        allocation_number: null,
        allocation_error_code: null,
      });
      expect(await room(admin, original.id)).toMatchObject({ credited_agorot: 1000, pending_agorot: 0, left_agorot: total - 1000 });

      const full = await creditBegin(creditor, original.id, { reason: "ביטול העסקה", amount_agorot: null });
      const fullTotals = (full.request as { totals: Record<string, number> }).totals;
      expect(fullTotals.total_agorot).toBe(total - 1000);
      expect(fullTotals.vat_agorot).toBeLessThanOrEqual(vat - share);
      expect(fullTotals.vat_agorot).toBeGreaterThanOrEqual(vat - share - 2);
      expect(fullTotals.net_agorot).toBe(total - 1000 - fullTotals.vat_agorot);
      expect(net).toBeGreaterThan(0);
      await expectLinesGiveTotals(full.request);
      expect((await pgError(creditBegin(admin, original.id, { reason: "שוב" }))).hint).toBe("invoice_credit:nothing_left");
      expect(await room(admin, original.id)).toMatchObject({ creditable: false, code: "nothing_left", left_agorot: 0 });
      // a credit the provider refused frees its amount again
      const job2 = await claimJob(full.request_id as string);
      await claimOf(job2);
      expect((await record(job2, { ok: false, code: "refused", final: true })).status).toBe("failed");
      await asService((q) => q("select public.finish_job($1, $2, true)", [job2.id, job2.lease]));
      expect(await room(admin, original.id)).toMatchObject({ creditable: true, left_agorot: total - 1000 });
    });

    it("a full first credit copies the original's lines; the same key answers the same request", async () => {
      const original = await issued();
      const key = randomUUID();
      const r = await creditBegin(owner, original.id, { reason: "החזרת סחורה" }, key);
      const request = r.request as { lines: { description: string }[]; totals: Record<string, number> };
      expect(request.lines.map((l) => l.description)).toEqual(taxableLines.map((l) => l.description));
      expect(request.totals).toMatchObject({
        total_agorot: original.request.totals.total_agorot,
        vat_agorot: original.request.totals.vat_agorot,
        net_agorot: original.request.totals.net_agorot,
      });
      const again = await creditBegin(owner, original.id, { reason: "אחר", amount_agorot: 5 }, key);
      expect(again.request_id).toBe(r.request_id);
      expect((await pgError(creditBegin(admin, original.id, { reason: "אחר" }, key))).hint).toBe("invoice:request");
    });

    it("an original cancelled after begin is refused by the claim; a hand-recorded or other-type document is not credited here", async () => {
      const original = await issued();
      const r = await creditBegin(admin, original.id, { reason: "טעות", amount_agorot: 500 });
      await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'בוטל' where id = $1", [original.id]));
      const out = await work(r.request_id as string, creditResult());
      expect(out).toMatchObject({ refused: "invoice_credit:original", status: "failed" });
      expect((await pgError(creditBegin(admin, original.id, { reason: "טעות" }))).hint).toBe("invoice_credit:original");

      const hand = await run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', $3, 11800) returning id", [org, person, `H-${randomUUID().slice(0, 8)}`])).id,
      );
      expect(await room(admin, hand)).toMatchObject({ creditable: false, code: "not_issued_here" });
      expect((await pgError(creditBegin(admin, hand, { reason: "טעות" }))).hint).toBe("invoice_credit:original");
      const receipt = await issued(doc({ doc_type: "receipt" }));
      expect(await room(admin, receipt.id)).toMatchObject({ creditable: false, code: "type" });
      // another business's document is not found
      expect((await pgError(run(outsider, (q) => q("select public.invoice_credit_room($1, $2)", [otherOrg, original.id])))).hint).toBe("invoice_credit:original");
    });

    it("credit lines give exactly the recorded totals, on a taxable, a mixed and a small amount; never more VAT than aimed", async () => {
      const taxable = await issued(doc({ lines: [{ description: "שירות", quantity: 1, unit_price_agorot: 10000, discount_agorot: 0, vat_exempt: false }] }));
      for (const amount_agorot of [1, 7, 333, 1001, 5555]) {
        const r = await creditBegin(admin, taxable.id, { reason: "בדיקה", amount_agorot });
        await expectLinesGiveTotals(r.request);
        const t = (r.request as { totals: Record<string, number> }).totals;
        const aimed = Math.floor((2 * amount_agorot * taxable.request.totals.vat_agorot + taxable.request.totals.total_agorot) / (2 * taxable.request.totals.total_agorot));
        expect(t.vat_agorot).toBeLessThanOrEqual(aimed);
        expect(t.total_agorot).toBe(amount_agorot);
      }
      // an exempt original is credited exempt
      const exempt = await issued(doc({ lines: [{ description: "פטור", quantity: 1, unit_price_agorot: 5000, discount_agorot: 0, vat_exempt: true }] }));
      const e = await creditBegin(admin, exempt.id, { reason: "בדיקה", amount_agorot: 1234 });
      expect((e.request as { lines: { vat_exempt: boolean }[]; totals: Record<string, number> }).lines.map((l) => l.vat_exempt)).toEqual([true]);
      expect((e.request as { totals: Record<string, number> }).totals.vat_agorot).toBe(0);
      await expectLinesGiveTotals(e.request);
    });

    describe("a mixed original is credited partly by chosen lines (owner (411) ב)", () => {
      const roomLines = async (id: string) => (await room(admin, id)).lines as { id: string; vat_exempt: boolean; total_agorot: number; left_agorot: number }[];

      it("the chosen lines are the credit's lines; the VAT follows them; what is left of each line goes down", async () => {
        const original = await issued(doc());
        const r0 = await room(admin, original.id);
        expect(r0).toMatchObject({ mixed: true, gross: false });
        const [taxed, exemptLine] = await roomLines(original.id);
        expect(taxed.vat_exempt).toBe(false);
        expect(exemptLine).toMatchObject({ vat_exempt: true, total_agorot: 4000, left_agorot: 4000 });
        // a mixed original takes no amount, and a line no more than is left of it
        expect((await pgError(creditBegin(admin, original.id, { reason: "x", amount_agorot: 500 }))).hint).toBe("invoice_credit:lines");
        expect((await pgError(creditBegin(admin, original.id, { reason: "x", lines: [{ line_id: exemptLine.id, amount_agorot: 4001 }] }))).hint).toBe("invoice_credit:amount");
        expect((await pgError(creditBegin(admin, original.id, { reason: "x", lines: [{ line_id: randomUUID() }] }))).hint).toBe("invoice_credit:lines");
        expect((await pgError(creditBegin(admin, original.id, { reason: "x", lines: [{ line_id: exemptLine.id }, { line_id: exemptLine.id }] }))).hint).toBe("invoice_credit:lines");

        const r = await creditBegin(admin, original.id, { reason: "החזרת נסיעות", lines: [{ line_id: exemptLine.id, amount_agorot: 1500 }] });
        const req = r.request as { lines: { vat_exempt: boolean; original_line_id: string }[]; totals: Record<string, number> };
        expect(req.totals).toMatchObject({ total_agorot: 1500, vat_agorot: 0, net_agorot: 1500 });
        expect(req.lines).toEqual([expect.objectContaining({ vat_exempt: true, original_line_id: exemptLine.id })]);
        await expectLinesGiveTotals(r.request);
        // reserved per line while pending
        expect((await roomLines(original.id))[1].left_agorot).toBe(2500);
        const job = await claimJob(r.request_id as string);
        await claimOf(job);
        const done = await record(job, { ok: true, ...creditResult() });
        await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
        expect(await asAdmin((q) => count(q, "select 1 from public.accounting_document_lines where document_id = $1 and credited_line_id = $2", [done.document_id, exemptLine.id]))).toBe(1);
        expect((await roomLines(original.id))[1].left_agorot).toBe(2500);

        // the taxable line: its VAT at the rate, on that line only
        const r2 = await creditBegin(admin, original.id, { reason: "ייעוץ", lines: [{ line_id: taxed.id, amount_agorot: 10000 }] });
        expect((r2.request as { totals: Record<string, number> }).totals).toMatchObject({ net_agorot: 10000, vat_agorot: 1800, total_agorot: 11800 });
        await expectLinesGiveTotals(r2.request);
        // the full rest takes every line's remaining part
        const full = await creditBegin(owner, original.id, { reason: "סגירה" });
        const fullReq = full.request as { lines: { original_line_id: string; unit_price_agorot: number }[]; totals: Record<string, number> };
        expect(fullReq.lines.map((l) => [l.original_line_id, l.unit_price_agorot])).toEqual([
          [taxed.id, taxed.total_agorot - 10000],
          [exemptLine.id, 2500],
        ]);
        await expectLinesGiveTotals(full.request);
      });

      it("lines are chosen only on a mixed original", async () => {
        const original = await issued();
        const [line] = await roomLines(original.id);
        expect((await room(admin, original.id)).mixed).toBe(false);
        expect((await pgError(creditBegin(admin, original.id, { reason: "x", lines: [{ line_id: line.id }] }))).hint).toBe("invoice_credit:lines");
      });
    });

    describe("the credit's reason on the recorded credit invoice (owner (409) ב)", () => {
      it("is kept, frozen, and erased with the document's lines", async () => {
        const original = await issued();
        const r = await creditBegin(admin, original.id, { reason: "דנה ביקשה לבטל", amount_agorot: 300 });
        const done = await work(r.request_id as string, creditResult());
        const reason = () => asAdmin(async (q) => (await one<{ r: string | null }>(q, "select credit_reason as r from public.accounting_documents where id = $1", [done.document_id])).r);
        expect(await reason()).toBe("דנה ביקשה לבטל");
        // members read it like the document; nobody changes it
        expect(await run(owner, async (q) => (await one<{ r: string }>(q, "select credit_reason as r from public.accounting_documents where id = $1", [done.document_id])).r)).toBe("דנה ביקשה לבטל");
        expect((await pgError(run(owner, (q) => q("update public.accounting_documents set credit_reason = 'אחר' where id = $1", [done.document_id])))).code).toBe("42501");
        expect((await pgError(asAdmin((q) => q("update public.accounting_documents set credit_reason = 'אחר' where id = $1", [done.document_id])))).hint).toBe("document:frozen");
        // a person never names one on a hand-recorded document
        expect((await pgError(run(owner, (q) => q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot, credit_reason) values ($1, $2, 'credit_invoice', 'X-9', 1, 'x')", [org, person])))).code).toBe("42501");
        // the erasure's step on the document's lines (app.audit_erase_core, app.document_server = 'erase')
        await asAdmin(async (q) => {
          await q("begin");
          await q("select set_config('app.document_server', 'erase', true)");
          await q("update public.accounting_document_lines set description = 'הפריט נמחק (מחיקת פרטיות)' where document_id = $1", [done.document_id]);
          await q("commit");
        });
        expect(await reason()).toBe("הסיבה נמחקה (מחיקת פרטיות)");
      });

      it("is erased when the document's audit entries are erased, also when its lines were already neutral", async () => {
        const original = await issued();
        const r = await creditBegin(admin, original.id, { reason: "יעל ביקשה", amount_agorot: 200 });
        const done = await work(r.request_id as string, creditResult());
        // the erasure's last step only (app.audit_erase_core): the document's entries become {"erased": true}
        await asAdmin((q) => q(`update public.audit_log set changes = '{"erased": true}'::jsonb where entity_type = 'accounting_documents' and entity_id = $1`, [done.document_id]));
        expect(await asAdmin(async (q) => (await one<{ r: string | null }>(q, "select credit_reason as r from public.accounting_documents where id = $1", [done.document_id])).r)).toBe("הסיבה נמחקה (מחיקת פרטיות)");
        expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and changes::text like '%יעל ביקשה%'", [done.document_id]))).toBe(0);
      });

      it("a real privacy erasure of the contact reaches it", async () => {
        const temp = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, last_name, owner_id) values ($1, 'רון', 'כהן', $2) returning id", [org, owner.id])).id);
        const r0 = await begin(owner, randomUUID(), "contact", temp, taxableDoc());
        const orig = await work(r0.request_id as string);
        const r = await creditBegin(admin, orig.document_id as string, { reason: "רון ביקש", amount_agorot: 300 });
        const done = await work(r.request_id as string, creditResult());
        // purge, then the person's erasure (app.audit_erase_core)
        await asAdmin((q) => q("delete from public.contacts where id = $1", [temp]));
        await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, temp]));
        expect(await asAdmin(async (q) => (await one<{ r: string | null }>(q, "select credit_reason as r from public.accounting_documents where id = $1", [done.document_id])).r)).toBe("הסיבה נמחקה (מחיקת פרטיות)");
        expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and changes::text like '%רון ביקש%'", [org]))).toBe(0);
        // and the request's copy of the reason
        expect(await asAdmin((q) => count(q, "select 1 from app.invoice_issue_requests where id = $1 and payload ->> 'reason' = 'הסיבה נמחקה (מחיקת פרטיות)'", [r.request_id]))).toBe(1);
      });
    });

    it("a hand-recorded credit without a VAT split counts the original's VAT share", async () => {
      const original = await issued(doc({ lines: [{ description: "שירות", quantity: 1, unit_price_agorot: 10000, discount_agorot: 0, vat_exempt: false }] }));
      const { total_agorot: total, vat_agorot: vat } = original.request.totals;
      await run(owner, (q) =>
        q("insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot, original_document_id) values ($1, $2, $3, 'credit_invoice', $4, $5, $6)", [org, deal, person, `HC-${randomUUID().slice(0, 8)}`, total - 800, original.id]),
      );
      const share = Math.floor((2 * (total - 800) * vat + total) / (2 * total));
      expect(await room(admin, original.id)).toMatchObject({ credited_agorot: total - 800, left_agorot: 800, vat_left_agorot: vat - share });
      const rest = await creditBegin(admin, original.id, { reason: "יתרה" });
      const t = (rest.request as { totals: Record<string, number> }).totals;
      expect(t.total_agorot).toBe(800);
      expect(t.vat_agorot).toBeLessThanOrEqual(vat - share);
      expect(t.vat_agorot).toBeLessThan(200);
      await expectLinesGiveTotals(rest.request);
    });

    describe("what a credit request reserves", () => {
      const reserved = async (id: string) => Number((await room(admin, id)).pending_agorot);
      const close = (u: U, request: unknown) => run(u, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_issue_close($1, $2) as r", [org, request])).r);
      const release = (u: U, request: unknown) => run(u, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_credit_release($1, $2) as r", [org, request])).r);
      // a first try that got no answer (a timeout): the job waits for its next try
      const timedOut = async (request: unknown) => {
        const job = await claimJob(request as string);
        await claimOf(job);
        expect(await record(job, { ok: false, code: "timeout", final: false })).toMatchObject({ status: "pending" });
        await asService((q) => q("select public.finish_job($1, $2, false, 'timeout', false)", [job.id, job.lease]));
        await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [job.id]));
        return job;
      };

      it("closed before any try reached the provider: released at once", async () => {
        const original = await issued();
        const r = await creditBegin(creditor, original.id, { reason: "טעות", amount_agorot: 1000 });
        expect(await reserved(original.id)).toBe(1000);
        expect(await close(creditor, r.request_id)).toMatchObject({ code: "closed" });
        expect(await reserved(original.id)).toBe(0);
        // its job is then refused as finished: nothing reaches the provider, and the room stays free after the worker ran
        expect(await work(r.request_id as string, creditResult())).toMatchObject({ refused: "finished" });
        expect(await reserved(original.id)).toBe(0);
      });

      it("marked stale before any try: reserved until its first claim answers finished, then free for good", async () => {
        const original = await issued();
        const r = await creditBegin(creditor, original.id, { reason: "טעות", amount_agorot: 700 });
        // what the stale sweep does to a request pending for a day
        await asAdmin((q) => q("update app.invoice_issue_requests set status = 'stale', error_code = 'stale', finished_at = now() where id = $1", [r.request_id]));
        expect(await reserved(original.id)).toBe(700);
        expect(await work(r.request_id as string, creditResult())).toMatchObject({ refused: "finished" });
        expect(await reserved(original.id)).toBe(0);
      });

      it("closed after a try: reserved until the late lookup says it is not at the provider", async () => {
        const original = await issued();
        const r = await creditBegin(admin, original.id, { reason: "טעות", amount_agorot: 1000 });
        await timedOut(r.request_id);
        await close(admin, r.request_id);
        expect(await reserved(original.id)).toBe(1000);
        const job = await claimJob(r.request_id as string);
        expect(await claimOf(job)).toMatchObject({ late: true });
        await record(job, { ok: false, code: "not_at_provider", final: true });
        await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
        expect(await reserved(original.id)).toBe(0);
        expect(await room(admin, original.id)).toMatchObject({ left_agorot: original.request.totals.total_agorot });
      });

      it("issued at the provider but not recorded: reserved until the same document is recorded by hand", async () => {
        const original = await issued();
        const r = await creditBegin(admin, original.id, { reason: "טעות", amount_agorot: 1000 });
        const job = await claimJob(r.request_id as string);
        await claimOf(job);
        const out = creditResult();
        // the record's outcome when the business could not record it (org_not_writable): kept with the provider's id and number
        await asAdmin((q) => q("update app.invoice_issue_requests set status = 'unrecorded', error_code = 'org_not_writable', provider_document_id = $2, number = $3, finished_at = now() where id = $1", [r.request_id, out.provider_document_id, out.number]));
        await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
        expect(await reserved(original.id)).toBe(1000);
        await run(owner, (q) =>
          q("insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot, original_document_id) values ($1, $2, $3, 'credit_invoice', $4, 1000, $5)", [org, deal, person, out.number, original.id]),
        );
        // counted once: as the recorded credit, no longer as a reservation
        expect(await room(admin, original.id)).toMatchObject({ credited_agorot: 1000, pending_agorot: 0, left_agorot: original.request.totals.total_agorot - 1000 });
      });

      it("one the provider issued is never released: it is recorded by hand", async () => {
        const original = await issued();
        const r = await creditBegin(admin, original.id, { reason: "טעות", amount_agorot: 400 });
        const job = await claimJob(r.request_id as string);
        await claimOf(job);
        const out = creditResult();
        await asAdmin((q) => q("update app.invoice_issue_requests set status = 'unrecorded', error_code = 'org_not_writable', provider_document_id = $2, number = $3, finished_at = now() where id = $1", [r.request_id, out.provider_document_id, out.number]));
        await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
        expect((await pgError(release(owner, r.request_id))).hint).toBe("invoice_credit:release");
        expect((await room(admin, original.id)).reserving).toEqual([expect.objectContaining({ id: r.request_id, at_provider: true })]);
      });

      it("the provider's credit recorded by hand at its full amount, with its provider number, is allowed and stops reserving", async () => {
        const original = await issued();
        const total = original.request.totals.total_agorot;
        const r = await creditBegin(admin, original.id, { reason: "ביטול", amount_agorot: null });
        const job = await claimJob(r.request_id as string);
        await claimOf(job);
        const out = creditResult();
        await asAdmin((q) => q("update app.invoice_issue_requests set status = 'unrecorded', error_code = 'org_not_writable', provider_document_id = $2, number = $3, finished_at = now() where id = $1", [r.request_id, out.provider_document_id, out.number]));
        await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
        expect(await room(admin, original.id)).toMatchObject({ pending_agorot: total, left_agorot: 0 });
        // another number above nothing left is refused; the provider's own number takes its reservation's place
        const hand = (number: string, amount: number) =>
          run(owner, (q) => q("insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot, original_document_id) values ($1, $2, $3, 'credit_invoice', $4, $5, $6)", [org, deal, person, number, amount, original.id]));
        expect(await pgError(hand(`HX-${randomUUID().slice(0, 8)}`, 1))).toMatchObject({ hint: "invoice_credit:hand_over", detail: "0" });
        await hand(out.number, total);
        expect(await room(admin, original.id)).toMatchObject({ credited_agorot: total, pending_agorot: 0, left_agorot: 0, reserving: [] });
      });

      it("a hand credit of exactly the amount left beside a reservation is allowed, one agora more is not", async () => {
        const original = await issued();
        const total = original.request.totals.total_agorot;
        await creditBegin(admin, original.id, { reason: "בהמתנה", amount_agorot: 2500 });
        const hand = (amount: number) =>
          run(owner, (q) => q("insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot, original_document_id) values ($1, $2, $3, 'credit_invoice', $4, $5, $6)", [org, deal, person, `HE-${randomUUID().slice(0, 8)}`, amount, original.id]));
        expect(await pgError(hand(total - 2500 + 1))).toMatchObject({ hint: "invoice_credit:hand_over", detail: String(total - 2500) });
        await hand(total - 2500);
        expect(await room(admin, original.id)).toMatchObject({ credited_agorot: total - 2500, pending_agorot: 2500, left_agorot: 0 });
      });

      it("a recorder who does not read the original learns nothing of it (refused as an unreadable original)", async () => {
        const original = await issued();
        await creditBegin(admin, original.id, { reason: "בהמתנה", amount_agorot: 2500 });
        const recorder = await addMember(org, owner.id, "member", "inv-recorder-own");
        await run(owner, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, recorder.id, ["documents"]]));
        await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
        try {
          const mine = await run(recorder, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'שלי') returning id", [org])).id);
          expect(await run(recorder, (q) => count(q, "select 1 from public.accounting_documents where id = $1", [original.id]))).toBe(0);
          const error = await pgError(
            run(recorder, (q) => q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot, original_document_id) values ($1, $2, 'credit_invoice', $3, 999999, $4)", [org, mine, `HR-${randomUUID().slice(0, 8)}`, original.id])),
          );
          // the same answer as a missing original: no hand_over, no remainder
          expect(error).toMatchObject({ hint: "document:original" });
          expect((error as { detail?: string }).detail ?? null).toBeNull();
          const missing = await pgError(
            run(recorder, (q) => q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot, original_document_id) values ($1, $2, 'credit_invoice', $3, 999999, $4)", [org, mine, `HM-${randomUUID().slice(0, 8)}`, randomUUID()])),
          );
          expect({ code: missing.code, hint: missing.hint }).toEqual({ code: error.code, hint: error.hint });
        } finally {
          await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
        }
      });

      it("a provider's credit cancelled here by hand still counts (it exists at the provider)", async () => {
        const original = await issued();
        const r = await creditBegin(admin, original.id, { reason: "טעות", amount_agorot: 600 });
        const done = await work(r.request_id as string, creditResult());
        await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'נרשם בטעות' where id = $1", [done.document_id]));
        expect(await room(admin, original.id)).toMatchObject({ credited_agorot: 600, left_agorot: original.request.totals.total_agorot - 600 });
      });

      it("a credit recorded by hand against a provider's original is refused above what is left, reservations included", async () => {
        const original = await issued();
        const total = original.request.totals.total_agorot;
        await creditBegin(admin, original.id, { reason: "בהמתנה", amount_agorot: total - 1000 });
        const hand = (amount: number) =>
          run(owner, (q) =>
            q("insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot, original_document_id) values ($1, $2, $3, 'credit_invoice', $4, $5, $6)", [org, deal, person, `HH-${randomUUID().slice(0, 8)}`, amount, original.id]),
          );
        const over = await pgError(hand(1001));
        // owner (412) א: the refusal carries what is left (agorot), which the message names
        expect(over).toMatchObject({ hint: "invoice_credit:hand_over", detail: "1000" });
        await hand(1000);
        expect((await pgError(hand(1))).hint).toBe("invoice_credit:hand_over");
        // a hand credit of an original recorded by hand is not judged here
        const handOriginal = await run(owner, async (q) =>
          (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', $3, 100) returning id", [org, person, `HO-${randomUUID().slice(0, 8)}`])).id,
        );
        await run(owner, (q) =>
          q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot, original_document_id) values ($1, $2, 'credit_invoice', $3, 500, $4)", [org, person, `HC-${randomUUID().slice(0, 8)}`, handOriginal]),
        );
      });

      it("stuck in check_provider: only owners and admins mark it checked or release it; then it frees its amount", async () => {
        const original = await issued();
        const r = await creditBegin(creditor, original.id, { reason: "טעות", amount_agorot: 1000 });
        await timedOut(r.request_id);
        // the next claim is the queue's last try
        await asAdmin((q) => q("update app.jobs set attempts = app.job_max_attempts() - 1 where id = (select job_id from app.invoice_issue_requests where id = $1)", [r.request_id]));
        const job = await claimJob(r.request_id as string);
        await claimOf(job);
        expect(await record(job, { ok: false, code: "timeout", final: false })).toMatchObject({ status: "unrecorded", code: "retries_spent" });
        await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
        expect(await reserved(original.id)).toBe(1000);
        expect((await listed(admin)).map((x) => x.id)).toContain(r.request_id);
        // the requester (not an owner or admin) cannot free it
        expect((await pgError(close(creditor, r.request_id))).hint).toBe("invoice_credit:check_admin");
        expect((await pgError(release(creditor, r.request_id))).code).toBe("42501");
        expect(await reserved(original.id)).toBe(1000);
        // why it ended stays; only the release is stamped
        expect(await release(admin, r.request_id)).toEqual({ status: "unrecorded", code: "retries_spent", released: true });
        expect(await reserved(original.id)).toBe(0);
        expect(await asAdmin(async (q) => (await one<Record<string, unknown>>(q, "select error_code, credit_released_by from app.invoice_issue_requests where id = $1", [r.request_id])))).toEqual({ error_code: "retries_spent", credit_released_by: admin.id });
        // releasing twice changes nothing
        expect(await release(admin, r.request_id)).toEqual({ status: "unrecorded", code: "retries_spent", released: true });
        // a released request leaves the list of requests to check at the provider
        expect((await listed(admin)).map((x) => x.id)).not.toContain(r.request_id);
      });

      it("an owner or admin releases a credit closed after a try whose lookup never came; pending or recorded ones are not released", async () => {
        const original = await issued();
        const r = await creditBegin(admin, original.id, { reason: "טעות", amount_agorot: 500 });
        expect((await pgError(release(admin, r.request_id))).hint).toBe("invoice_credit:release");
        await timedOut(r.request_id);
        await close(admin, r.request_id);
        expect(await reserved(original.id)).toBe(500);
        // its job can still run (a late lookup may yet record it): not released while it can, and the page says so
        expect((await pgError(release(owner, r.request_id))).hint).toBe("invoice_credit:release_wait");
        expect((await room(admin, original.id)).reserving).toEqual([expect.objectContaining({ id: r.request_id, job_waiting: true })]);
        expect(await reserved(original.id)).toBe(500);
        // the lookup never came: its job died
        await asAdmin((q) => q("update app.jobs set status = 'dead', finished_at = now() where id = (select job_id from app.invoice_issue_requests where id = $1)", [r.request_id]));
        expect((await room(admin, original.id)).reserving).toEqual([expect.objectContaining({ id: r.request_id, job_waiting: false })]);
        expect(await release(owner, r.request_id)).toEqual({ status: "unrecorded", code: "closed", released: true });
        expect(await reserved(original.id)).toBe(0);
        // an issue request is not a credit request
        const issue = await begin(owner, randomUUID(), "deal", deal);
        expect((await pgError(release(admin, issue.request_id))).hint).toBe("invoice:request");
      });

      it("an issue request's requester still closes it as checked (DOC-07 unchanged)", async () => {
        const r = await begin(issuer, randomUUID(), "contact", person, doc({ doc_type: "receipt" }));
        const job = await claimJob(r.request_id as string);
        await claimOf(job);
        await asAdmin((q) => q("update app.jobs set attempts = app.job_max_attempts() where id = $1", [job.id]));
        await record(job, { ok: false, code: "timeout", final: false });
        await asService((q) => q("select public.finish_job($1, $2, true)", [job.id, job.lease]));
        expect(await close(issuer, r.request_id)).toEqual({ status: "unrecorded", code: "checked" });
      });
    });

    it("an erased request loses a credit's reason too", async () => {
      const erased = await asAdmin(async (q) =>
        (await one<{ r: Record<string, unknown> }>(q, "select app.invoice_issue_payload_erased($1) as r", [JSON.stringify({ doc_type: "credit_invoice", reason: "דנה ביקשה", lines: [{ description: "x" }] })])).r,
      );
      expect(erased.reason).toBe("הסיבה נמחקה (מחיקת פרטיות)");
      expect((erased.lines as { description: string }[])[0].description).toBe("הפריט נמחק (מחיקת פרטיות)");
    });
  });
});
