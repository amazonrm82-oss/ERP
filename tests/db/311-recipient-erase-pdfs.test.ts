import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";
import { MIGRATIONS_DIR, migrationFile } from "./rerun";

afterAll(closePool);

type U = { id: string; email: string };
type Store = { status: string; path?: string; file_id?: string };
type Line = { recipient?: string | null };
type Page = { lines?: Line[] };

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * PKG-06, owner's answer (167) ב (9 November 2026): a service recipient's privacy erasure removes only the payer's quote PDF
 * as sent and the order's PDF (app.recipient_pdf_drop, the pasted 20261006021188); the signed quote PDF (QUO-09) stays. The
 * lines lose the name, so the page and the PDF made again show no "עבור" line; the PDF made again is not counted in
 * max_pdf_per_month (021015's rule for a remake, through app.recipient_pdf_credits). Other payers' documents and other
 * businesses are untouched.
 */
describe("a service recipient's erasure and the payer's PDFs (PKG-06, owner (167) ב)", () => {
  let owner: U;
  let org: string;
  let product: string;
  let outsider: U;
  let outsiderOrg: string;
  const FEATURES = { products: true, payments: true, punch_cards: true, orders: true, quotes: true, documents: true };
  const sha = (c: string) => c.repeat(64);

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const contact = (first: string, last: string | null = null) =>
    run(async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, last_name, owner_id) values ($1, $2, $3, $4) returning id", [org, first, last, owner.id])).id,
    );
  const relate = async (a: string, b: string) => {
    const type = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.contact_relation_types where organization_id = $1 and key = 'parent'", [org])).id);
    await run((q) => q("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, a, b, type]));
  };
  const quote = (payer: string, recipient: string) =>
    run(async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, payer])).id;
      await q(
        `insert into public.quote_lines (organization_id, quote_id, name, product_id, unit_price_agorot, quantity, position, recipient_contact_id)
         values ($1, $2, 'כרטיסייה', $3, 40000, 1, 0, $4)`,
        [org, id, product, recipient],
      );
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
  const order = (payer: string, recipient: string) =>
    run(async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, payer])).id;
      await q(
        `insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity, position, recipient_contact_id)
         values ($1, $2, 'כרטיסייה', $3, 40000, 1, 0, $4)`,
        [org, id, product, recipient],
      );
      await q("select public.order_confirm($1, $2)", [org, id]);
      return id;
    });
  const putObject = (path: string) =>
    asAdmin(async (q) => {
      await q("insert into storage.objects (bucket_id, name) values ('record-files', $1) on conflict do nothing", [path]);
      await q("update storage.objects set metadata = jsonb_build_object('size', 20000::bigint, 'mimetype', 'application/pdf') where bucket_id = 'record-files' and name = $1", [path]);
    });
  const storeQuote = (q1: string, digest: string) =>
    asService(async (q) => (await one<{ r: Store }>(q, "select public.quote_pdf_store($1, $2, $3, 20000, $4, 'הצעה.pdf') as r", [org, q1, owner.id, digest])).r);
  // the content stamp a render reads (orders.pdf_content_changed_at); a stale one answers `changed`
  const orderStamp = (o1: string) =>
    asAdmin(async (q) => (await one<{ s: string | null }>(q, "select pdf_content_changed_at::text as s from public.orders where id = $1", [o1])).s);
  const storeOrder = async (o1: string, digest: string, path: string | null = null, stamp?: string | null) => {
    const read = stamp === undefined ? await orderStamp(o1) : stamp;
    return asService(
      async (q) =>
        (await one<{ r: Store }>(q, "select public.order_pdf_store($1, $2, $3, 20000, $4, 'אישור הזמנה.pdf', $5, $6::timestamptz) as r", [org, o1, owner.id, digest, path, read])).r,
    );
  };
  const storedQuote = async (q1: string, digest = sha("a")) => {
    const first = await storeQuote(q1, digest);
    expect(first.status).toBe("upload");
    await putObject(first.path!);
    expect((await storeQuote(q1, digest)).status).toBe("stored");
    return first.path!;
  };
  const storedOrder = async (o1: string, digest = sha("b")) => {
    const first = await storeOrder(o1, digest);
    expect(first.status).toBe("upload");
    await putObject(first.path!);
    expect((await storeOrder(o1, digest, first.path!)).status).toBe("stored");
    return first.path!;
  };
  const filesOf = (column: "quote_id" | "order_id", id: string) =>
    asAdmin(
      async (q) =>
        (await q<{ id: string; previous_id: string | null; quote_signed: boolean | null }>(
          `select id, previous_id, quote_signed from public.files where ${column} = $1 order by created_at, id`,
          [id],
        )).rows,
    );
  const nameOf = (kind: "quote" | "order", doc: string) =>
    asAdmin(async (q) => (await one<{ n: string | null }>(q, `select recipient_name as n from public.${kind}_lines where ${kind}_id = $1`, [doc])).n);
  const produced = () =>
    asAdmin(async (q) => (await q<{ produced: number }>("select produced from app.pdf_months where organization_id = $1 and month = app.automation_run_month($1)", [org])).rows[0]?.produced ?? 0);
  const link = (q1: string) => run(async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, q1])).t);
  const page = (token: string) => asService(async (q) => (await one<{ p: Page }>(q, "select public.quote_public($1) as p", [token])).p);
  const accept = async (token: string) => {
    const fp = await asService(async (q) => (await one<{ v: { fingerprint: string } }>(q, "select public.quote_public_version($1) as v", [token])).v.fingerprint);
    const answer = await asService(
      async (q) =>
        (
          await one<{ a: { status: string } }>(
            q,
            `select public.quote_public_answer(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'רחל כהן',
                      p_signature_kind => 'drawn', p_signature_image => $3, p_wording_version => 'draft-2026-10-18', p_agreed => true,
                      p_ip => '192.0.2.10', p_user_agent => 'Mozilla/5.0', p_optional_keys => null::integer[], p_accepted_total_agorot => null) as a`,
            [token, fp, PNG],
          )
        ).a,
    );
    expect(answer.status).toBe("accepted");
  };
  const sign = async (token: string, q1: string) => {
    const fingerprint = await asAdmin(async (q) => (await one<{ f: string }>(q, "select coalesce(choice_sha256, content_sha256) as f from public.quote_decisions where quote_id = $1", [q1])).f);
    const call = (path: string | null) =>
      asService(
        async (q) =>
          (await one<{ r: Store }>(q, "select public.quote_signed_pdf_public_store($1, 20000, $2, 'הצעה חתומה.pdf', $3, $4) as r", [token, sha("e"), path, fingerprint])).r,
      );
    const first = await call(null);
    expect(first.status).toBe("upload");
    await putObject(first.path!);
    const second = await call(first.path!);
    expect(second.status).toBe("stored");
    return second.file_id!;
  };
  const erase = async (id: string) => {
    await asAdmin((q) => q("delete from public.contacts where id = $1", [id]));
    await run((q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, id]));
  };

  beforeAll(async () => {
    owner = await createUser("rep-owner");
    org = await createOrg(owner.id, "סטודיו המחיקות");
    outsider = await createUser("rep-outsider");
    outsiderOrg = await createOrg(outsider.id, "עסק אחר");
    for (const o of [org, outsiderOrg]) {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2, limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{\"max_pdf_per_month\": 1000}'::jsonb where organization_id = $1", [o, JSON.stringify(FEATURES)]));
      await asAdmin((q) =>
        q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [o]),
      );
    }
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    const typeId = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.meeting_types where organization_id = $1 order by position, created_at, id limit 1", [org])).id);
    product = await run(async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.products (organization_id, name, kind, price_agorot, punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids)
           values ($1, 'כרטיסיית חוג', 'punch_card', 40000, 10, 3, 'months', $2) returning id`,
          [org, [typeId]],
        )
      ).id,
    );
  });

  it("removes the accepted quote's PDF as sent and the order's PDF, keeps the signed PDF, and leaves other payers alone", async () => {
    const payer = await contact("רחל", "כהן");
    const kid = await contact("נתן", "המחוק");
    await relate(payer, kid);
    const q1 = await quote(payer, kid);
    await storedQuote(q1);
    const token = await link(q1);
    await accept(token);
    const signed = await sign(token, q1);
    expect((await filesOf("quote_id", q1)).map((f) => f.quote_signed)).toEqual([null, true]);
    const o1 = await order(payer, kid);
    const orderPath = await storedOrder(o1);
    // another payer whose recipient is someone else keeps everything
    const otherPayer = await contact("דנה");
    const otherKid = await contact("יואב");
    await relate(otherPayer, otherKid);
    const q2 = await quote(otherPayer, otherKid);
    await storedQuote(q2);
    const o2 = await order(otherPayer, otherKid);
    await storedOrder(o2);

    await erase(kid);
    // the signed PDF stays, now the quote's first file; the PDF as sent is gone
    expect(await filesOf("quote_id", q1)).toEqual([{ id: signed, previous_id: null, quote_signed: true }]);
    expect(await filesOf("order_id", o1)).toEqual([]);
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [orderPath]))).toBe(1);
    // the customer's download still serves the signed PDF
    const pdf = await asService(async (q) => (await one<{ p: { sha256?: string } }>(q, "select public.quote_public_pdf($1, null) as p", [token])).p);
    expect(pdf.sha256).toBe(sha("e"));
    // the name is emptied: no "עבור" line on the page
    expect(await nameOf("quote", q1)).toBeNull();
    expect(await nameOf("order", o1)).toBeNull();
    expect((await page(token)).lines?.[0].recipient ?? null).toBeNull();
    // other payers' documents untouched
    expect(await filesOf("quote_id", q2)).toHaveLength(1);
    expect(await filesOf("order_id", o2)).toHaveLength(1);
    expect(await nameOf("quote", q2)).toBe("יואב");
    // owner (172) ב: the accepted quote's PDF as sent is made again through the staff path (the person's own session asks
    // first), not counted, after the signed PDF it now follows; the signed PDF is untouched and still what the customer gets
    const asked = (fn: string) => run(async (q) => (await one<{ b: boolean }>(q, `select public.${fn}($1, $2) as b`, [org, q1])).b);
    expect(await asked("quote_pdf_allowed")).toBe(false);
    expect(await asked("quote_pdf_recipient_remake_allowed")).toBe(true);
    expect(await asked("recipient_pdf_remake_pending")).toBe(true);
    const before = await produced();
    await storedQuote(q1, sha("f"));
    expect(await produced()).toBe(before);
    const now = await filesOf("quote_id", q1);
    expect(now).toHaveLength(2);
    expect(now.find((f) => f.quote_signed === null)?.previous_id).toBe(signed);
    expect(now.find((f) => f.quote_signed === true)).toMatchObject({ id: signed, previous_id: null });
    const again = await asService(async (q) => (await one<{ p: { sha256?: string } }>(q, "select public.quote_public_pdf($1, null) as p", [token])).p);
    expect(again.sha256).toBe(sha("e"));
    // one audit entry for the remake; the marker is used, so nothing more is let through
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'pdf_remake' and entity_id = $2 and changes ->> 'recipient_erasure' = 'true'", [org, now.find((f) => f.quote_signed === null)!.id]))).toBe(1);
    // second review M1: the staff screen is told the stored file is such a remake (an ordinary file is not)
    const remadeFile = now.find((f) => f.quote_signed === null)!.id;
    const remade = (file: string) => run(async (q) => (await one<{ b: boolean }>(q, "select public.recipient_pdf_remade($1, $2) as b", [org, file])).b);
    expect(await remade(remadeFile)).toBe(true);
    expect(await remade(signed)).toBe(false);
    expect(await asUser(outsider.id, async (q) => (await one<{ b: boolean }>(q, "select app.recipient_pdf_remade_check($1, $2) as b", [org, remadeFile])).b)).toBe(false);
    expect(await asUser(outsider.id, async (q) => (await one<{ b: boolean }>(q, "select public.recipient_pdf_remade($1, $2) as b", [org, remadeFile])).b)).toBe(false);
    expect(await asked("recipient_pdf_remake_pending")).toBe(false);
    expect(await asked("quote_pdf_recipient_remake_allowed")).toBe(false);
    expect((await storeQuote(q1, sha("f"))).status).toBe("stored");
    // a closed quote no erasure touched is still refused
    const plain = await quote(payer, payer);
    const plainToken = await link(plain);
    await accept(plainToken);
    expect(await run(async (q) => (await one<{ b: boolean }>(q, "select public.quote_pdf_recipient_remake_allowed($1, $2) as b", [org, plain])).b)).toBe(false);
    expect((await pgError(storeQuote(plain, sha("9")))).hint).toBe("quote_pdf:closed");
  });

  it("the PDFs made again show no name and are not counted in the quota; a later PDF is counted", async () => {
    const payer = await contact("מיכל");
    const kid = await contact("עמית", "המחוק");
    await relate(payer, kid);
    const q1 = await quote(payer, kid);
    await storedQuote(q1);
    const o1 = await order(payer, kid);
    await storedOrder(o1);
    await erase(kid);
    expect(await filesOf("quote_id", q1)).toEqual([]);
    expect(await filesOf("order_id", o1)).toEqual([]);
    const credits = () =>
      asAdmin(async (q) =>
        (await q<{ q: string | null; o: string | null; used: boolean }>(
          "select quote_id as q, order_id as o, used_at is not null as used from app.recipient_pdf_credits where organization_id = $1 and (quote_id = $2 or order_id = $3) order by quote_id nulls last",
          [org, q1, o1],
        )).rows,
      );
    expect(await credits()).toEqual([
      { q: q1, o: null, used: false },
      { q: null, o: o1, used: false },
    ]);
    const before = await produced();
    await storedQuote(q1, sha("c"));
    await storedOrder(o1, sha("d"));
    expect(await produced()).toBe(before);
    expect((await credits()).map((c) => c.used)).toEqual([true, true]);
    expect(await nameOf("quote", q1)).toBeNull();
    // a new PDF of another quote is counted as before
    const q3 = await quote(payer, payer);
    const before3 = await produced();
    await storedQuote(q3);
    expect(await produced()).toBe(before3 + 1);
  });

  it("a waiting PDF that took a credit and is removed gives the credit back, never a count", async () => {
    const payer = await contact("שרה");
    const kid = await contact("אורן", "המחוק");
    await relate(payer, kid);
    const q1 = await quote(payer, kid);
    await storedQuote(q1);
    await erase(kid);
    const before = await produced();
    const first = await storeQuote(q1, sha("c"));
    expect(first.status).toBe("upload");
    const waiting = (await filesOf("quote_id", q1))[0].id;
    expect(await asAdmin((q) => count(q, "select 1 from app.recipient_pdf_credits where quote_id = $1 and used_file_id = $2", [q1, waiting]))).toBe(1);
    await asAdmin((q) => q("delete from public.files where id = $1", [waiting]));
    expect(await asAdmin((q) => count(q, "select 1 from app.recipient_pdf_credits where quote_id = $1 and used_at is null", [q1]))).toBe(1);
    expect(await produced()).toBe(before);
  });

  it("the credits, the removal and the helpers are reachable by no client; another business is untouched", async () => {
    // the other business's quote naming its own recipient keeps its PDF and name through this business's erasures
    const oPayer = await asUser(outsider.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'זר', $2) returning id", [outsiderOrg, outsider.id])).id);
    const oQuote = await asUser(outsider.id, async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [outsiderOrg, oPayer])).id);
    expect(oQuote).toBeTruthy();
    for (const u of [owner, outsider]) {
      expect((await pgError(asUser(u.id, (q) => q("select * from app.recipient_pdf_credits")))).code).toBe("42501");
      expect((await pgError(asUser(u.id, (q) => q("select app.recipient_pdf_drop($1, array[$2]::uuid[], '{}')", [org, oQuote])))).code).toBe("42501");
      expect((await pgError(asUser(u.id, (q) => q("select app.recipient_pdf_credit_use($1, $2, null, gen_random_uuid())", [org, oQuote])))).code).toBe("42501");
    }
    expect((await pgError(asService((q) => q("select app.recipient_pdf_drop($1, '{}', '{}')", [org])))).code).toBe("42501");
    // the removal of one business never reaches another's rows, even when named
    const payer = await contact("רוני");
    const kid = await contact("גל", "המחוק");
    await relate(payer, kid);
    const q1 = await quote(payer, kid);
    await storedQuote(q1);
    await asAdmin((q) => q("select app.recipient_pdf_drop($1, array[$2]::uuid[], '{}')", [outsiderOrg, q1]));
    expect(await filesOf("quote_id", q1)).toHaveLength(1);
  });

  // review 1: until 021188 is pasted, 021187's placeholder keeps 021185's behaviour (every PDF of the documents goes, through
  // app.quote_pdf_drop / app.order_pdf_drop), and credits follow what was really removed
  it("021187's placeholder removes the documents' PDFs as 021185 did, with credits for what it really removed", async () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, migrationFile("_recipient_erase_pdfs.sql")), "utf8");
    const body = /execute \$f\$([\s\S]*?)\$f\$;/.exec(sql)?.[1];
    expect(body).toContain("app.quote_pdf_drop");
    const placeholder = body!.replace("create function", "create or replace function");
    const payer = await contact("אביגיל");
    const kid = await contact("ליאור", "המחוק");
    await relate(payer, kid);
    const q1 = await quote(payer, kid);
    await storedQuote(q1);
    const token = await link(q1);
    await accept(token);
    await sign(token, q1);
    const o1 = await order(payer, kid);
    await storedOrder(o1);
    const sentinel = new Error("rollback");
    const seen = await asAdmin(async (q) => {
      await q(placeholder);
      await q("delete from public.contacts where id = $1", [kid]);
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner.id, role: "authenticated" })]);
      await q("set local role authenticated");
      await q("select public.audit_erase_record($1, 'contacts', $2)", [org, kid]);
      await q("reset role");
      const result = {
        quoteFiles: await count(q, "select 1 from public.files where quote_id = $1", [q1]),
        orderFiles: await count(q, "select 1 from public.files where order_id = $1", [o1]),
        credits: (await q<{ q: string | null; o: string | null }>("select quote_id as q, order_id as o from app.recipient_pdf_credits where quote_id = $1 or order_id = $2 order by quote_id nulls last", [q1, o1])).rows,
      };
      throw Object.assign(sentinel, { result });
    }).catch((error: Error & { result?: unknown }) => {
      if (error !== sentinel) throw error;
      return error.result;
    });
    // 021185's behaviour: the signed PDF goes too; a credit for the quote's PDF as sent and the order's PDF that went
    expect(seen).toEqual({ quoteFiles: 0, orderFiles: 0, credits: [{ q: q1, o: null }, { q: null, o: o1 }] });
    // rolled back: the pasted body is still the one in force
    expect(await filesOf("quote_id", q1)).toHaveLength(2);
    expect(await asAdmin(async (q) => (await one<{ d: string }>(q, "select pg_get_functiondef('app.recipient_pdf_drop(uuid, uuid[], uuid[])'::regprocedure) as d")).d)).toContain("delete from public.files");
  });

  // review 4: a second erasure while a file made again with the credit still waits takes that file and keeps the credit
  it("a second erasure while the remade file still waits leaves the credit free and counts nothing", async () => {
    const payer = await contact("יעל");
    const kid1 = await contact("רון", "המחוק");
    const kid2 = await contact("שני", "המחוקה");
    await relate(payer, kid1);
    await relate(payer, kid2);
    const q1 = await run(async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, payer])).id;
      for (const [position, kid] of [[0, kid1], [1, kid2]] as const) {
        await q(
          `insert into public.quote_lines (organization_id, quote_id, name, product_id, unit_price_agorot, quantity, position, recipient_contact_id)
           values ($1, $2, 'כרטיסייה', $3, 40000, 1, $4, $5)`,
          [org, id, product, position, kid],
        );
      }
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    await storedQuote(q1);
    await erase(kid1);
    const before = await produced();
    expect((await storeQuote(q1, sha("c"))).status).toBe("upload");
    expect(await asAdmin((q) => count(q, "select 1 from app.recipient_pdf_credits where quote_id = $1 and used_file_id is not null", [q1]))).toBe(1);
    await erase(kid2);
    expect(await filesOf("quote_id", q1)).toEqual([]);
    expect(await asAdmin((q) => count(q, "select 1 from app.recipient_pdf_credits where quote_id = $1 and used_at is null", [q1]))).toBe(1);
    expect(await produced()).toBe(before);
    await storedQuote(q1, sha("d"));
    expect(await produced()).toBe(before);
  });

  // review 5: an order render that read the content before the erasure is refused as `changed`
  it("an order render that read the content before the erasure stores nothing", async () => {
    const payer = await contact("טובה");
    const kid = await contact("אייל", "המחוק");
    await relate(payer, kid);
    const o1 = await order(payer, kid);
    await storedOrder(o1);
    const stale = await orderStamp(o1);
    await erase(kid);
    expect(await orderStamp(o1)).not.toEqual(stale);
    expect((await storeOrder(o1, sha("f"), null, stale)).status).toBe("changed");
    expect(await filesOf("order_id", o1)).toEqual([]);
    expect((await storeOrder(o1, sha("f"))).status).toBe("upload");
  });
});
