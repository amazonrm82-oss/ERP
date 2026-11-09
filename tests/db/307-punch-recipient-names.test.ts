import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cardForExport } from "@/features/punch-cards/export";

import { asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Line = { recipient?: string | null; name?: string };
type Page = { lines?: Line[]; status_page?: unknown };

/**
 * PKG-06 follow-up (owner's answer (156) א, 9 November 2026): the customer's quote and order pages and PDFs show a punch
 * card line's service recipient as "עבור: <name as sent>". The name is a server-only snapshot taken when the quote is sent or
 * the order numbered, copied by a version and an order from the quote, frozen afterwards (a rename or a purge changes
 * nothing), only on the full page (never the status page), and replaced by a neutral text by the person's erasure.
 */
describe("the service recipient's name as sent (PKG-06, owner (156) א)", () => {
  let owner: U;
  let org: string;
  let product: string;
  const FEATURES = { products: true, payments: true, punch_cards: true, orders: true, quotes: true, documents: true };

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
  const quote = (payer: string) =>
    run(async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, payer])).id);
  const order = (payer: string) =>
    run(async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, payer])).id);
  const line = (kind: "quote" | "order", doc: string, recipient: string | null, position = 0) =>
    run(async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.${kind}_lines (organization_id, ${kind}_id, name, product_id, unit_price_agorot, quantity, position, recipient_contact_id)
           values ($1, $2, 'כרטיסייה', $3, 40000, 1, $4, $5) returning id`,
          [org, doc, product, position, recipient],
        )
      ).id,
    );
  const nameOf = (kind: "quote" | "order", lineId: string) =>
    asAdmin(async (q) => (await one<{ n: string | null }>(q, `select recipient_name as n from public.${kind}_lines where id = $1`, [lineId])).n);
  const linesOf = (kind: "quote" | "order", doc: string) =>
    asAdmin(async (q) => (await q<{ id: string; n: string | null; r: string | null }>(`select id, recipient_name as n, recipient_contact_id as r from public.${kind}_lines where ${kind}_id = $1 order by position`, [doc])).rows);
  const send = (q1: string) => run((q) => q("select public.quote_send($1, $2)", [org, q1]));
  const confirm = (o1: string) => run((q) => q("select public.order_confirm($1, $2)", [org, o1]));
  const quotePage = async (q1: string) => {
    const token = await run(async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, q1])).t);
    return { token, page: () => asService(async (q) => (await one<{ p: Page }>(q, "select public.quote_public($1) as p", [token])).p) };
  };
  const orderPage = async (o1: string) => {
    const token = await run(async (q) => (await one<{ t: string }>(q, "select public.order_link_create($1, $2) as t", [org, o1])).t);
    return () => asService(async (q) => (await one<{ p: Page }>(q, "select public.order_public($1, null) as p", [token])).p);
  };
  const rename = (id: string, first: string) => run((q) => q("update public.contacts set first_name = $2, last_name = null where id = $1", [id, first]));

  beforeAll(async () => {
    owner = await createUser("prn-owner");
    org = await createOrg(owner.id, "סטודיו השמות");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    await asAdmin((q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
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

  it("the name is taken when the quote is sent, shown on the page, and frozen: a rename changes nothing, no writer sets it", async () => {
    const parent = await contact("רונית", "לוי");
    const child = await contact("נועה", "לוי");
    await relate(parent, child);
    const q1 = await quote(parent);
    const l1 = await line("quote", q1, child, 0);
    const self = await line("quote", q1, parent, 1);
    const plain = await line("quote", q1, null, 2);
    // a draft has no name yet; a person has no grant on the column
    expect(await nameOf("quote", l1)).toBeNull();
    expect((await pgError(run((q) => q("update public.quote_lines set recipient_name = 'אחר' where id = $1", [l1])))).code).toBe("42501");
    // a server write on a draft is put back too
    await asAdmin((q) => q("update public.quote_lines set recipient_name = 'אחר' where id = $1", [l1]));
    expect(await nameOf("quote", l1)).toBeNull();
    await send(q1);
    expect(await nameOf("quote", l1)).toBe("נועה לוי");
    // the payer itself, and a line with no recipient, show nothing
    expect(await nameOf("quote", self)).toBeNull();
    expect(await nameOf("quote", plain)).toBeNull();
    const { page } = await quotePage(q1);
    expect((await page()).lines?.map((l) => l.recipient ?? null)).toEqual(["נועה לוי", null, null]);
    // a later rename never changes what the customer sees; no writer changes the stored name
    await rename(child, "שם חדש");
    await asAdmin((q) => q("update public.quote_lines set recipient_name = 'אחר' where id = $1", [l1]));
    expect(await nameOf("quote", l1)).toBe("נועה לוי");
    expect((await page()).lines?.[0].recipient).toBe("נועה לוי");
  });

  it("a version and an order from the quote keep the name as sent; a draft's changed recipient is taken again at sending", async () => {
    const parent = await contact("משה");
    const child = await contact("יעל");
    const other = await contact("עמית");
    await relate(parent, child);
    await relate(parent, other);
    const q1 = await quote(parent);
    await line("quote", q1, child, 0);
    await line("quote", q1, child, 1);
    await send(q1);
    await rename(child, "יעל אחרי");
    // a version copies the name of the line it copied the recipient from; one line's recipient is changed on the draft
    const version = await run(async (q) => (await one<{ id: string }>(q, "select public.quote_new_version($1, $2) as id", [org, q1])).id);
    const vLines = await linesOf("quote", version);
    expect(vLines.map((l) => l.n)).toEqual(["יעל", "יעל"]);
    await run((q) => q("update public.quote_lines set recipient_contact_id = $2 where id = $1", [vLines[1].id, other]));
    expect(await nameOf("quote", vLines[1].id)).toBeNull();
    await send(version);
    expect((await linesOf("quote", version)).map((l) => l.n)).toEqual(["יעל", "עמית"]);
    // an order made from the accepted quote keeps the quote's names, even after a rename
    await rename(other, "עמית אחרי");
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [version]));
    const orderId = await run(async (q) => (await one<{ r: string }>(q, "select public.order_from_quote($1, $2) as r", [org, version])).r);
    expect((await linesOf("order", orderId)).map((l) => l.n)).toEqual(["יעל", "עמית"]);
  });

  it("the name is taken when the order is numbered, shown on the order page, and never on a status page", async () => {
    const parent = await contact("דוד");
    const child = await contact("תמר", "כהן");
    await relate(parent, child);
    const o1 = await order(parent);
    const ol = await line("order", o1, child);
    expect(await nameOf("order", ol)).toBeNull();
    await confirm(o1);
    expect(await nameOf("order", ol)).toBe("תמר כהן");
    const page = await orderPage(o1);
    expect((await page()).lines?.[0].recipient).toBe("תמר כהן");
    await run((q) => q("update public.orders set status = 'cancelled' where id = $1", [o1]));
    const cancelled = await page();
    expect(cancelled.status_page).toBeTruthy();
    expect(JSON.stringify(cancelled)).not.toContain("תמר");
    // a cancelled quote's link: the status page carries no lines and no name
    const q1 = await quote(parent);
    await line("quote", q1, child);
    await send(q1);
    const { page: qPage } = await quotePage(q1);
    expect((await qPage()).lines?.[0].recipient).toBe("תמר כהן");
    await run((q) => q("select public.quote_cancel($1, $2)", [org, q1]));
    const status = await qPage();
    expect(status.status_page).toBeTruthy();
    expect(JSON.stringify(status)).not.toContain("תמר");
  });

  it("a purge keeps the name; a merge carries it to the kept contact, whose erasure empties it with a neutral text and its log", async () => {
    const parent = await contact("אסתר");
    const gone = await contact("אורי", "בן");
    await relate(parent, gone);
    const q1 = await quote(parent);
    const l1 = await line("quote", q1, gone);
    await send(q1);
    // the duplicate is merged into the kept contact: the name stays as sent, its owner is now the kept contact
    const dup = await contact("אורי", "בן כפול");
    await relate(parent, dup);
    const o1 = await order(parent);
    const ol = await line("order", o1, dup);
    await confirm(o1);
    expect(await nameOf("order", ol)).toBe("אורי בן כפול");
    await run((q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, gone, dup]));
    expect(await nameOf("order", ol)).toBe("אורי בן כפול");
    expect(await asAdmin(async (q) => (await one<{ n: string | null }>(q, "select recipient_named_contact_id as n from public.order_lines where id = $1", [ol])).n)).toBe(gone);
    // purge: the recipient's id goes, the name as sent stays
    await asAdmin((q) => q("delete from public.contacts where id = $1", [gone]));
    expect((await linesOf("quote", q1))[0]).toMatchObject({ r: null, n: "אורי בן" });
    expect(await nameOf("order", ol)).toBe("אורי בן כפול");
    // the erasure: a neutral text on both lines, and no log entry keeps the name or the id
    await run((q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, gone]));
    expect(await nameOf("quote", l1)).toBe("השם נמחק (מחיקת פרטיות)");
    expect(await nameOf("order", ol)).toBe("השם נמחק (מחיקת פרטיות)");
    const log = JSON.stringify(
      await asAdmin(async (q) => (await q("select changes from public.audit_log where organization_id = $1 and entity_type in ('quote_lines', 'order_lines')", [org])).rows),
    );
    expect(log).not.toContain("אורי");
    expect(log).not.toContain(gone);
    const { page } = await quotePage(q1);
    expect((await page()).lines?.[0].recipient).toBe("השם נמחק (מחיקת פרטיות)");
  });

  // review HIGH 1: the stored PDFs printed the name; the erasure removes them so they are made again from the neutral data
  it("the recipient's erasure removes the stored PDFs of the payer's quote and order that named them, and only those", async () => {
    type Store = { status: string; path?: string; file_id?: string };
    const sha = (c: string) => c.repeat(64);
    const putObject = (path: string) =>
      asAdmin(async (q) => {
        await q("insert into storage.objects (bucket_id, name) values ('record-files', $1) on conflict do nothing", [path]);
        await q("update storage.objects set metadata = jsonb_build_object('size', 20000::bigint, 'mimetype', 'application/pdf') where bucket_id = 'record-files' and name = $1", [path]);
      });
    const storeQuote = (q1: string, digest: string) =>
      asService(async (q) => (await one<{ r: Store }>(q, "select public.quote_pdf_store($1, $2, $3, 20000, $4, 'הצעה.pdf') as r", [org, q1, owner.id, digest])).r);
    const storeOrder = (o1: string, digest: string, path: string | null = null) =>
      asService(async (q) => (await one<{ r: Store }>(q, "select public.order_pdf_store($1, $2, $3, 20000, $4, 'אישור הזמנה.pdf', $5) as r", [org, o1, owner.id, digest, path])).r);
    const storedQuote = async (q1: string) => {
      const first = await storeQuote(q1, sha("a"));
      expect(first.status).toBe("upload");
      await putObject(first.path!);
      expect((await storeQuote(q1, sha("a"))).status).toBe("stored");
      return first.path!;
    };
    const storedOrder = async (o1: string) => {
      const first = await storeOrder(o1, sha("b"));
      expect(first.status).toBe("upload");
      await putObject(first.path!);
      expect((await storeOrder(o1, sha("b"), first.path!)).status).toBe("stored");
      return first.path!;
    };
    const files = (column: "quote_id" | "order_id", id: string) => asAdmin((q) => count(q, `select 1 from public.files where ${column} = $1`, [id]));
    const queued = (path: string) => asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1 and bucket = 'record-files'", [path]));

    const parent = await contact("רחל");
    const kid = await contact("נתן", "המחוק");
    const sibling = await contact("שירה");
    await relate(parent, kid);
    await relate(parent, sibling);
    const q1 = await quote(parent);
    await line("quote", q1, kid);
    await send(q1);
    const quotePath = await storedQuote(q1);
    const o1 = await order(parent);
    await line("order", o1, kid);
    await confirm(o1);
    const orderPath = await storedOrder(o1);
    // a quote of the same payer that never named the erased person keeps its PDF
    const other = await quote(parent);
    await line("quote", other, sibling);
    await send(other);
    await storedQuote(other);

    await asAdmin((q) => q("delete from public.contacts where id = $1", [kid]));
    await run((q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, kid]));
    expect(await files("quote_id", q1)).toBe(0);
    expect(await files("order_id", o1)).toBe(0);
    expect(await queued(quotePath)).toBe(1);
    expect(await queued(orderPath)).toBe(1);
    expect(await files("quote_id", other)).toBe(1);
    // the next render is a fresh file, made from the stored data, which now holds the neutral text
    expect((await storeQuote(q1, sha("c"))).status).toBe("upload");
    expect((await storeOrder(o1, sha("d"))).status).toBe("upload");
    expect((await linesOf("quote", q1))[0].n).toBe("השם נמחק (מחיקת פרטיות)");
    expect((await linesOf("order", o1))[0].n).toBe("השם נמחק (מחיקת פרטיות)");
  });

  // review LOW 2: a deleted draft line that held the duplicate's name is reached by the kept contact's erasure after a merge
  it("after a merge, the kept contact's erasure reaches the log of a deleted draft line that named the duplicate", async () => {
    const parent = await contact("גילה");
    const keep = await contact("עידו", "הנשאר");
    const dup = await contact("עידו", "הכפיל-הנמחק");
    await relate(parent, dup);
    const q1 = await quote(parent);
    await line("quote", q1, dup);
    await send(q1);
    // a version copies the name; its draft line is then deleted (its delete entry carries the name)
    const version = await run(async (q) => (await one<{ id: string }>(q, "select public.quote_new_version($1, $2) as id", [org, q1])).id);
    const vLine = (await linesOf("quote", version))[0];
    expect(vLine.n).toBe("עידו הכפיל-הנמחק");
    await run((q) => q("delete from public.quote_lines where id = $1", [vLine.id]));
    const logOf = async () =>
      JSON.stringify(
        await asAdmin(async (q) => (await q("select changes from public.audit_log where organization_id = $1 and entity_type in ('quote_lines', 'order_lines')", [org])).rows),
      );
    expect(await logOf()).toContain("הכפיל-הנמחק");
    await run((q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep, dup]));
    await asAdmin((q) => q("delete from public.contacts where id = $1", [keep]));
    await run((q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, keep]));
    const log = await logOf();
    expect(log).not.toContain("הכפיל-הנמחק");
    expect(log).not.toContain(keep);
  });

  // review LOW 3: the card keeps saying it was opened for another payer after the payer is purged
  it("a card's 'opened for another payer' stays after the payer is purged, and only the server sets it", async () => {
    const parent = await contact("ציפי");
    const kid = await contact("אלון");
    const card = await run(async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [org, kid, product])).id);
    const flag = () => asAdmin(async (q) => (await one<{ f: boolean; p: string | null }>(q, "select opened_for_other_payer as f, payer_contact_id as p from public.punch_cards where id = $1", [card])));
    expect((await flag()).f).toBe(false);
    // a server write cannot set it by itself
    await asAdmin((q) => q("update public.punch_cards set opened_for_other_payer = true where id = $1", [card]));
    expect((await flag()).f).toBe(false);
    await asAdmin((q) => q("update public.punch_cards set payer_contact_id = $2 where id = $1", [card, parent]));
    expect(await flag()).toEqual({ f: true, p: parent });
    await asAdmin((q) => q("delete from public.contacts where id = $1", [parent]));
    expect(await flag()).toEqual({ f: true, p: null });
    // and no writer clears it
    await asAdmin((q) => q("update public.punch_cards set opened_for_other_payer = false where id = $1", [card]));
    expect((await flag()).f).toBe(true);
  });

  // second review LOW: a merge that makes the payer the holder makes the card the holder's own purchase again
  it("a merge that makes the payer the card's holder clears the mark; the export then keeps the holder's own purchase", async () => {
    const row = (card: string) => asAdmin(async (q) => (await q<Record<string, unknown>>("select * from public.punch_cards where id = $1", [card])).rows[0]);
    const exportOf = (card: Record<string, unknown>, ids: string[]) =>
      cardForExport({ ...card, created_at: new Date(card.created_at as string).toISOString() }, [], ids, "Asia/Jerusalem");
    // (a) the payer (a duplicate) is merged into the recipient who holds the card from its opening (merge_punch_recipients'
    // first card update): the card is the holder's own purchase, so the mark goes and the purchase stays in the export
    const holder = await contact("מרים");
    const payerDup = await contact("מרים", "כפולה");
    const card = await run(async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [org, holder, product])).id);
    await asAdmin((q) => q("update public.punch_cards set payer_contact_id = $2, price_agorot = 40000 where id = $1", [card, payerDup]));
    expect((await row(card)).opened_for_other_payer).toBe(true);
    await run((q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, holder, payerDup]));
    const after = await row(card);
    expect(after).toMatchObject({ contact_id: holder, payer_contact_id: null, opened_for_other_payer: false });
    const exported = exportOf(after, [holder]);
    expect(exported).not.toHaveProperty("opened_from");
    expect(Number(exported.price_agorot)).toBe(40000);
    expect(exported).toHaveProperty("payment_id");
    expect(exported).toHaveProperty("activated_at");
    // (b) the recipient (a duplicate) is merged into the payer (the second card update): the mark goes too; the card came to
    // the payer by the merge, so PKG-01's holding rule (unchanged) leaves its purchase out of the kept contact's export
    const parent = await contact("נחמה");
    const kidDup = await contact("נחמה", "כפולה");
    const card2 = await run(async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [org, kidDup, product])).id);
    await asAdmin((q) => q("update public.punch_cards set payer_contact_id = $2 where id = $1", [card2, parent]));
    await run((q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, parent, kidDup]));
    const after2 = await row(card2);
    expect(after2).toMatchObject({ contact_id: parent, payer_contact_id: null, opened_for_other_payer: false });
    expect(exportOf(after2, [parent])).not.toHaveProperty("opened_from");
    // a card still held by someone other than its payer keeps its mark through the same kind of merge
    const other = await contact("רועי");
    const otherDup = await contact("רועי", "כפול");
    const held = await run(async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [org, other, product])).id);
    await asAdmin((q) => q("update public.punch_cards set payer_contact_id = $2 where id = $1", [held, otherDup]));
    await run((q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, holder, otherDup]));
    expect(await asAdmin(async (q) => (await one<{ f: boolean; p: string }>(q, "select opened_for_other_payer as f, payer_contact_id as p from public.punch_cards where id = $1", [held])))).toEqual({
      f: true,
      p: holder,
    });
  });
});
