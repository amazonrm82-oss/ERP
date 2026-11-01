import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Store = { status: string; path?: string; file_id?: string };
type Pdf = { path?: string; sha256?: string; name?: string; unavailable?: boolean };

/**
 * ORD-05 PDF versions (owner, 1 November 2026, answer (34) ב): a change to a numbered order's delivery date, shipping address or
 * notes makes a new order PDF; the previous one is kept as a version for staff (files.previous_id, one newer version per file),
 * the customer gets the newest confirmed one, and every new version counts in max_pdf_per_month.
 */
describe("order PDF versions (ORD-05, answer (34) ב)", () => {
  let owner: U, member: U, other: U;
  let org: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const sha = (c: string) => c.repeat(64);
  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);

  const newOrder = (u: U) =>
    run(u, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נועה', $2) returning id", [org, u.id])).id;
      const order = (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id, notes) values ($1, $2, 'הערה') returning id", [org, contact])).id;
      await q("insert into public.order_lines (organization_id, order_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, order]);
      await q("select public.order_confirm($1, $2)", [org, order]);
      return order;
    });
  const call = (u: U, orderId: string, digest: string, path: string | null = null) =>
    asService(
      async (q) => (await one<{ r: Store }>(q, "select public.order_pdf_store($1, $2, $3, 20000, $4, 'אישור הזמנה.pdf', $5) as r", [org, orderId, u.id, digest, path])).r,
    );
  const putObject = (path: string) =>
    asAdmin(async (q) => {
      await q("insert into storage.objects (bucket_id, name) values ('record-files', $1) on conflict do nothing", [path]);
      await q("update storage.objects set metadata = '{\"size\": 20000, \"mimetype\": \"application/pdf\"}'::jsonb where bucket_id = 'record-files' and name = $1", [path]);
    });
  const storeFully = async (u: U, orderId: string, digest: string) => {
    const first = await call(u, orderId, digest);
    expect(first.status).toBe("upload");
    await putObject(first.path!);
    const second = await call(u, orderId, digest, first.path!);
    expect(second.status).toBe("stored");
    return { id: second.file_id!, path: first.path! };
  };
  const files = (orderId: string) =>
    asAdmin(async (q) => (await q<{ id: string; previous_id: string | null; sha256: string }>("select id, previous_id, sha256 from public.files where order_id = $1 order by created_at, id", [orderId])).rows);
  const link = (u: U, orderId: string) => run(u, async (q) => (await one<{ t: string }>(q, "select public.order_link_create($1, $2) as t", [org, orderId])).t);
  const download = (token: string) => asService(async (q) => (await one<{ p: Pdf }>(q, "select public.order_public_pdf($1, null) as p", [token])).p);
  const produced = () =>
    asAdmin(async (q) => (await q<{ produced: number }>("select produced from app.pdf_months where organization_id = $1 and month = app.automation_run_month($1)", [org])).rows[0]?.produced ?? 0);
  // created_at is the transaction's time: move the first file back so "changed after it was made" is clear
  const age = (orderId: string) => asAdmin((q) => q("update public.files set created_at = created_at - interval '1 minute' where order_id = $1", [orderId]));

  beforeAll(async () => {
    owner = await createUser("opv-owner");
    org = await createOrg(owner.id, "עסק הגרסאות");
    member = await addMember(org, owner.id, "member", "opv-member");
    other = await addMember(org, owner.id, "member", "opv-other");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"orders\": true}'::jsonb where organization_id = $1", [org]));
    await asAdmin((q) =>
      q("update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{\"max_pdf_per_month\": 1000}'::jsonb where organization_id = $1", [org]),
    );
    await run(owner, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)
         on conflict (organization_id) do update set vat_status = 'licensed', prices_include_vat = false`,
        [org],
      ),
    );
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
  });

  it("the change time is server-kept: set by a change of the three fields on a numbered order only", async () => {
    const order = await newOrder(member);
    const changed = () => asAdmin(async (q) => (await one<{ c: Date | null }>(q, "select pdf_content_changed_at as c from public.orders where id = $1", [order])).c);
    expect(await changed()).toBeNull();
    expect(await asAdmin((q) => one<{ c: boolean }>(q, "select has_column_privilege('authenticated', 'public.orders', 'pdf_content_changed_at', 'update') as c"))).toEqual({ c: false });
    expect((await pgError(run(member, (q) => q("update public.orders set pdf_content_changed_at = now() where id = $1", [order])))).code).toBe("42501");
    await run(member, (q) => q("update public.orders set status = 'in_progress' where id = $1", [order]));
    expect(await changed()).toBeNull();
    for (const [column, value] of [
      ["delivery_date", "2026-12-01"],
      ["shipping_address", "רחוב חדש 1"],
      ["notes", "הערה חדשה"],
    ] as const) {
      await asAdmin((q) => q("update public.orders set pdf_content_changed_at = null where id = $1", [order]));
      await run(member, (q) => q(`update public.orders set ${column} = $2 where id = $1`, [order, value]));
      expect(await changed(), column).not.toBeNull();
    }
    // a draft's changes are not marked
    const draft = await run(member, async (q) => {
      const c = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'טיוטה', $2) returning id", [org, member.id])).id;
      return (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id;
    });
    await run(member, (q) => q("update public.orders set notes = 'x' where id = $1", [draft]));
    expect(await asAdmin((q) => one<{ c: Date | null }>(q, "select pdf_content_changed_at as c from public.orders where id = $1", [draft]))).toEqual({ c: null });
  });

  for (const [column, value] of [
    ["delivery_date", "2026-12-24"],
    ["shipping_address", "רחוב הגפן 9, חיפה"],
    ["notes", "לתאם מראש"],
  ] as const) {
    it(`a change of ${column} makes a new version after the current one; the customer gets the newest; staff read both; counted`, async () => {
      const order = await newOrder(member);
      const token = await link(member, order);
      const first = await storeFully(member, order, sha("a"));
      await age(order);
      // nothing changed: the same file
      expect(await call(member, order, sha("b"))).toEqual({ status: "stored", file_id: first.id });
      const before = await produced();
      await run(member, (q) => q(`update public.orders set ${column} = $2 where id = $1`, [order, value]));
      const second = await storeFully(member, order, sha("c"));
      expect(second.id).not.toBe(first.id);
      expect(await produced()).toBe(before + 1);
      expect(await files(order)).toEqual([
        { id: first.id, previous_id: null, sha256: sha("a") },
        { id: second.id, previous_id: first.id, sha256: sha("c") },
      ]);
      // the customer gets the newest; staff (who read the order) read both; another member reads neither
      expect(await download(token)).toMatchObject({ path: second.path, sha256: sha("c") });
      expect(await run(member, (q) => count(q, "select 1 from public.files where order_id = $1", [order]))).toBe(2);
      expect(await run(owner, (q) => count(q, "select 1 from public.files where order_id = $1", [order]))).toBe(2);
      expect(await run(other, (q) => count(q, "select 1 from public.files where order_id = $1", [order]))).toBe(0);
      // the new one is current: another call answers it
      expect(await call(member, order, sha("d"))).toEqual({ status: "stored", file_id: second.id });
      // the old version is kept
      expect((await pgError(asAdmin((q) => q("delete from public.files where id = $1", [first.id])))).hint).toBe("file:kept");
    });
  }

  it("any other edit makes no new version", async () => {
    const order = await newOrder(member);
    const first = await storeFully(member, order, sha("1"));
    await age(order);
    await run(member, (q) => q("update public.orders set status = 'in_progress' where id = $1", [order]));
    await run(member, (q) => q("update public.orders set delivery_contact_id = null where id = $1", [order]));
    // the same values again count as no change
    await run(member, (q) => q("update public.orders set notes = notes where id = $1", [order]));
    expect(await call(member, order, sha("2"))).toEqual({ status: "stored", file_id: first.id });
    expect(await files(order)).toHaveLength(1);
  });

  it("while a new version waits, the customer still gets the confirmed one; a full month refuses the new version", async () => {
    const order = await newOrder(member);
    const token = await link(member, order);
    const first = await storeFully(member, order, sha("3"));
    await age(order);
    await run(member, (q) => q("update public.orders set notes = 'שונה' where id = $1", [order]));
    const waiting = await call(member, order, sha("4"));
    expect(waiting.status).toBe("upload");
    expect(await download(token)).toMatchObject({ path: first.path, sha256: sha("3") });
    // an owner removes the waiting version: the first is current again, the count is given back
    const counted = await produced();
    const waitingId = (await files(order)).find((f) => f.previous_id === first.id)!.id;
    expect(await run(owner, async (q) => (await q("delete from public.files where id = $1 returning id", [waitingId])).rows.length)).toBe(1);
    expect(await produced()).toBe(counted - 1);
    // the month is full: no new version, the first stays served
    await asAdmin((q) =>
      q("update public.subscriptions set limit_overrides = limit_overrides || jsonb_build_object('max_pdf_per_month', $2::numeric) where organization_id = $1", [org, counted - 1]),
    );
    try {
      expect((await pgError(call(member, order, sha("5")))).hint).toBe("limit:max_pdf_per_month");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = limit_overrides || '{\"max_pdf_per_month\": 1000}'::jsonb where organization_id = $1", [org]));
    }
    expect(await download(token)).toMatchObject({ sha256: sha("3") });
  });

  it("an order's files stay one line: a version follows only the current confirmed file of the same order", async () => {
    const order = await newOrder(member);
    const otherOrder = await newOrder(member);
    const first = await storeFully(member, order, sha("6"));
    const theirs = await storeFully(member, otherOrder, sha("7"));
    const insert = (orderId: string, previous: string | null) =>
      asAdmin((q) =>
        q("insert into public.files (organization_id, order_id, previous_id, name, mime_type, size_bytes, sha256) values ($1, $2, $3, 'x.pdf', 'application/pdf', 1, $4)", [
          org,
          orderId,
          previous,
          sha("8"),
        ]),
      );
    // another order's file as the earlier version, or a second first file
    expect((await pgError(insert(order, theirs.id))).hint).toBe("order_pdf:version");
    expect((await pgError(insert(order, null))).code).toBe("23505");
    // a version of a version that is no longer current
    await age(order);
    await run(member, (q) => q("update public.orders set notes = 'אחרת' where id = $1", [order]));
    await storeFully(member, order, sha("9"));
    // REC-07's own rule answers first (files_links_check: one newer version per file)
    expect((await pgError(insert(order, first.id))).hint).toBe("file:version_taken");
  });

  it("a privacy erasure removes every version", async () => {
    const { contact, order } = await run(member, async (q) => {
      const c = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'דנה', $2) returning id", [org, member.id])).id;
      const o = (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id;
      await q("insert into public.order_lines (organization_id, order_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, o]);
      await q("select public.order_confirm($1, $2)", [org, o]);
      return { contact: c, order: o };
    });
    await storeFully(member, order, sha("a"));
    await age(order);
    await run(member, (q) => q("update public.orders set notes = 'חדש' where id = $1", [order]));
    await storeFully(member, order, sha("b"));
    expect(await files(order)).toHaveLength(2);
    await run(owner, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [contact]);
      await q("delete from public.contacts where id = $1", [contact]);
    });
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    expect(await files(order)).toHaveLength(0);
  });
});
