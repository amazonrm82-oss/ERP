import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Store = { status: string; path?: string; file_id?: string };
type Pdf = { path?: string; sha256?: string; name?: string; unavailable?: boolean; rate_limited?: boolean };

/**
 * ORD-05 PDF (owner, 1 November 2026, DECISIONS.md "מסמכי PDF שנשארו בגל 2", answer (1) ב; CLAUDE.md hard rule 5): the order
 * confirmation's PDF is stored once per numbered order, in QUO-06's pattern (tests 242 and 245 for quotes):
 * - only the server writes it, through public.order_pdf_store (service_role only), after the person's right is checked with
 *   their own session (public.order_pdf_allowed) and again for that user inside the function; files.sha256 is server-only;
 *   authenticated can neither insert the row nor put its object; each attempt its own path, abandoned paths to the cleanup;
 * - it counts in max_pdf_per_month (app.pdf_take: the month's quota, 30 a minute), and a removed waiting row gives it back;
 * - it is kept: nobody removes a confirmed one, an owner or admin removes a waiting row, a privacy erasure removes it;
 * - the customer downloads it through public.order_public_pdf (service_role only) under the order link's rule and limits,
 *   answered as path, SHA-256 and name only; public.order_public says when there is one.
 */
describe("order confirmation PDFs (ORD-05 PDF)", () => {
  let owner: U, admin: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const sha = (c: string) => c.repeat(64);
  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);

  const newOrder = (u: U, orgId = org, confirm = true) =>
    run(u, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נועה לוי', $2) returning id", [orgId, u.id])).id;
      const order = (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id, notes) values ($1, $2, 'הערה') returning id", [orgId, contact])).id;
      await q("insert into public.order_lines (organization_id, order_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [orgId, order]);
      if (confirm) await q("select public.order_confirm($1, $2)", [orgId, order]);
      return { contact, order };
    });
  const call = (u: U, orderId: string, digest = sha("a"), orgId = org, size = 20000, path: string | null = null) =>
    asService(
      async (q) =>
        (await one<{ r: Store }>(q, "select public.order_pdf_store($1, $2, $3, $4, $5, 'אישור הזמנה.pdf', $6) as r", [orgId, orderId, u.id, size, digest, path])).r,
    );
  const putObject = (path: string, size = 20000, type = "application/pdf") =>
    asAdmin(async (q) => {
      await q("insert into storage.objects (bucket_id, name) values ('record-files', $1) on conflict do nothing", [path]);
      await q("update storage.objects set metadata = jsonb_build_object('size', $2::bigint, 'mimetype', $3::text) where bucket_id = 'record-files' and name = $1", [
        path,
        size,
        type,
      ]);
    });
  const storeFully = async (u: U, orderId: string, digest = sha("a"), orgId = org) => {
    const first = await call(u, orderId, digest, orgId);
    expect(first.status).toBe("upload");
    await putObject(first.path!);
    const second = await call(u, orderId, digest, orgId, 20000, first.path!);
    expect(second.status).toBe("stored");
    return { id: second.file_id!, path: first.path! };
  };
  const allowed = (u: U, orderId: string, orgId = org) =>
    run(u, async (q) => (await one<{ a: boolean }>(q, "select public.order_pdf_allowed($1, $2) as a", [orgId, orderId])).a);
  const link = (u: U, orderId: string, orgId = org) => run(u, async (q) => (await one<{ t: string }>(q, "select public.order_link_create($1, $2) as t", [orgId, orderId])).t);
  const download = (token: string, ip: string | null = null) =>
    asService(async (q) => (await one<{ p: Pdf }>(q, "select public.order_public_pdf($1, $2) as p", [token, ip])).p);
  const page = (token: string) => asService(async (q) => (await one<{ p: Record<string, unknown> }>(q, "select public.order_public($1, null) as p", [token])).p);
  const row = (orderId: string) =>
    asAdmin(async (q) => one<{ id: string; p: string; s: string; u: Date | null }>(q, "select id, storage_path as p, sha256 as s, unconfirmed_since as u from public.files where order_id = $1", [orderId]));
  const sees = (u: U, fileId: string) => run(u, (q) => count(q, "select 1 from public.files where id = $1", [fileId]));
  const remove = (u: U, fileId: string) => run(u, async (q) => (await q("delete from public.files where id = $1 returning id", [fileId])).rows.length);
  const queued = (path: string) => asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1 and bucket = 'record-files'", [path]));
  const produced = () =>
    asAdmin(async (q) => (await q<{ produced: number }>("select produced from app.pdf_months where organization_id = $1 and month = app.automation_run_month($1)", [org])).rows[0]?.produced ?? 0);
  const setLimit = (n: number) =>
    asAdmin((q) =>
      q("update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || jsonb_build_object('max_pdf_per_month', $2::numeric) where organization_id = $1", [org, n]),
    );
  const resetCount = () => asAdmin((q) => q("update app.pdf_months set produced = 0, minute_count = 0, minute_start = null, warned_80_at = null where organization_id = $1", [org]));
  const setFeatures = (orgId: string, features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [orgId, JSON.stringify(features)]));
  const resetWindows = (orderId: string) =>
    asAdmin(async (q) => {
      await q("update app.order_links set window_count = 0, window_started_at = null where order_id = $1", [orderId]);
      await q("update app.order_pdf_download_counts set downloads = 0 where order_id = $1", [orderId]);
    });

  beforeAll(async () => {
    owner = await createUser("opdf-owner");
    org = await createOrg(owner.id, "עסק ההזמנות");
    admin = await addMember(org, owner.id, "admin", "opdf-admin");
    member = await addMember(org, owner.id, "member", "opdf-member");
    other = await addMember(org, owner.id, "member", "opdf-other");
    viewer = await addMember(org, owner.id, "viewer", "opdf-viewer");
    outsider = await createUser("opdf-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    for (const [u, o] of [
      [owner, org],
      [outsider, otherOrg],
    ] as const) {
      await setFeatures(o, { orders: true });
      await run(u, (q) =>
        q(
          `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)
           on conflict (organization_id) do update set vat_status = 'licensed', prices_include_vat = false`,
          [o],
        ),
      );
      await asAdmin((q) =>
        q("update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{\"max_pdf_per_month\": 1000}'::jsonb where organization_id = $1", [o]),
      );
    }
    // visibility "own": another member neither reads nor edits the member's orders
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
  });

  it("the write and download functions are for service_role only; the right check is for signed-in people", async () => {
    const { order } = await newOrder(owner);
    for (const fn of ["public.order_pdf_store(uuid, uuid, uuid, bigint, text, text, text)", "public.order_public_pdf(text, text)", "public.order_pdf_allowed(uuid, uuid)"]) {
      const can = async (role: string) => (await asAdmin((q) => one<{ c: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as c", [role, fn]))).c;
      const serviceOnly = fn !== "public.order_pdf_allowed(uuid, uuid)";
      expect(await can("anon"), fn).toBe(false);
      expect(await can("authenticated"), fn).toBe(!serviceOnly);
      if (serviceOnly) expect(await can("service_role"), fn).toBe(true);
    }
    for (const fn of ["app.order_pdf_user_may(uuid, uuid, uuid, uuid, uuid)", "app.order_pdf_drop(uuid, uuid[])", "app.files_order_pdf()", "app.files_order_pdf_return()"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect((await asAdmin((q) => one<{ c: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as c", [role, fn]))).c, `${fn} ${role}`).toBe(false);
      }
    }
    expect((await pgError(run(owner, (q) => q("select public.order_pdf_store($1, $2, $3, 1, $4, 'x.pdf')", [org, order, owner.id, sha("a")])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.order_public_pdf('x', null)")))).code).toBe("42501");
    for (const u of [owner, outsider]) expect((await pgError(run(u, (q) => q("select * from app.order_pdf_download_counts")))).code, u.email).toBe("42501");
  });

  it("asks the person's right with their own session: editors of a numbered, open order yes, others no", async () => {
    const { order } = await newOrder(member);
    expect(await allowed(member, order)).toBe(true);
    expect(await allowed(owner, order)).toBe(true);
    expect(await allowed(admin, order)).toBe(true);
    for (const u of [other, viewer, outsider]) expect(await allowed(u, order), u.email).toBe(false);
    expect(await allowed(outsider, order, otherOrg)).toBe(false);
    const draft = await newOrder(member, org, false);
    expect(await allowed(member, draft.order)).toBe(false);
    const cancelled = await newOrder(member);
    await run(member, (q) => q("update public.orders set status = 'cancelled' where id = $1", [cancelled.order]));
    expect(await allowed(member, cancelled.order)).toBe(false);
  });

  it("checks the user again inside the function; never across businesses; bad details refused", async () => {
    const { order } = await newOrder(member);
    for (const u of [other, viewer, outsider]) expect((await pgError(call(u, order))).code, u.email).toBe("42501");
    const theirs = await newOrder(outsider, otherOrg);
    expect((await pgError(call(owner, theirs.order))).code).toBe("42501");
    expect((await pgError(call(outsider, order, sha("a"), otherOrg))).code).toBe("42501");
    expect((await pgError(call(owner, theirs.order, sha("a"), otherOrg))).code).toBe("42501");
    expect(await asAdmin((q) => count(q, "select 1 from public.files where order_id = any($1)", [[order, theirs.order]]))).toBe(0);
    // a suspended member loses it
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, member.id]));
    try {
      expect((await pgError(call(member, order))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, member.id]));
    }
    expect((await pgError(call(owner, order, "not-a-sha"))).hint).toBe("order_pdf:invalid");
    expect((await pgError(call(owner, order, sha("a"), org, 0))).hint).toBe("order_pdf:invalid");
  });

  it("a draft and a cancelled order get none; it needs the orders flag", async () => {
    const draft = await newOrder(owner, org, false);
    expect((await pgError(call(owner, draft.order))).hint).toBe("order_pdf:draft");
    const cancelled = await newOrder(owner);
    await run(owner, (q) => q("update public.orders set status = 'cancelled' where id = $1", [cancelled.order]));
    expect((await pgError(call(owner, cancelled.order))).hint).toBe("order_pdf:closed");
    const { order } = await newOrder(owner);
    await setFeatures(org, { orders: false });
    try {
      expect((await pgError(call(owner, order))).hint).toBe("feature:orders");
    } finally {
      await setFeatures(org, { orders: true });
    }
    expect(await asAdmin((q) => count(q, "select 1 from public.files where order_id = any($1)", [[draft.order, cancelled.order, order]]))).toBe(0);
  });

  it("authenticated can neither write an order's row nor its object", async () => {
    const { order } = await newOrder(owner);
    expect(
      (
        await pgError(
          run(owner, (q) => q("insert into public.files (organization_id, order_id, name, mime_type, size_bytes) values ($1, $2, 'x.pdf', 'application/pdf', 1)", [org, order])),
        )
      ).code,
    ).toBe("42501");
    expect(await asAdmin((q) => one<{ c: boolean }>(q, "select has_column_privilege('authenticated', 'public.files', 'order_id', 'insert') as c"))).toEqual({ c: false });
    const first = await call(owner, order);
    await asAdmin((q) => q("update public.files set uploaded_by = $2 where order_id = $1", [order, owner.id]));
    expect((await pgError(run(owner, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [first.path])))).code).toBe("42501");
  });

  it("one PDF per order, each attempt on its own path; a stale upload never lands on the confirmed one", async () => {
    const { order } = await newOrder(owner);
    const first = await call(owner, order, sha("b"));
    expect(first).toEqual({ status: "upload", path: expect.stringMatching(new RegExp(`^${org}/`)) });
    const p1 = first.path!;
    expect(await call(owner, order, sha("b"), org, 20000, p1)).toEqual(first);
    // the wrong size on it: abandoned (queued) and a fresh path
    await putObject(p1, 999);
    const moved = await call(owner, order, sha("b"), org, 20000, p1);
    const p2 = moved.path!;
    expect(moved.status).toBe("upload");
    expect(p2).not.toBe(p1);
    expect(await queued(p1)).toBe(1);
    // another render while this one is on its way: busy; after two minutes taken over
    expect(await call(owner, order, sha("c"))).toEqual({ status: "busy" });
    await asAdmin((q) => q("update public.files set upload_checked_at = now() - interval '3 minutes' where order_id = $1", [order]));
    const taken = await call(owner, order, sha("c"));
    const p3 = taken.path!;
    expect([p1, p2]).not.toContain(p3);
    expect(await queued(p2)).toBe(1);
    // a non-PDF object is never confirmed
    await putObject(p3, 20000, "image/png");
    const notPdf = await call(owner, order, sha("c"), org, 20000, p3);
    expect(notPdf.status).toBe("upload");
    const p4 = notPdf.path!;
    await putObject(p4);
    const done = await call(owner, order, sha("c"), org, 20000, p4);
    expect(done.status).toBe("stored");
    expect(await row(order)).toMatchObject({ p: p4, s: sha("c"), u: null });
    // stored once: later calls answer the same file, a stale path is queued
    expect(await call(owner, order, sha("d"))).toEqual(done);
    expect(await call(owner, order, sha("b"), org, 20000, p2)).toEqual(done);
    expect(await asAdmin((q) => count(q, "select 1 from public.files where order_id = $1", [order]))).toBe(1);
    // the fingerprint is server-written only
    expect((await pgError(run(owner, (q) => q("update public.files set sha256 = $2 where id = $1", [done.file_id, sha("d")])))).code).toBe("42501");
  });

  it("the nightly confirmation never confirms an order's server row", async () => {
    const { order } = await newOrder(owner);
    const first = await call(owner, order, sha("9"));
    await putObject(first.path!);
    await asAdmin((q) => q("update public.files set unconfirmed_since = now() - interval '20 minutes', upload_checked_at = null where order_id = $1", [order]));
    await asAdmin((q) => q("select app.reconcile_pending_files(5000)"));
    expect((await row(order)).u).not.toBeNull();
    expect((await call(owner, order, sha("9"), org, 20000, first.path!)).status).toBe("stored");
  });

  it("whoever reads the order reads its PDF; others do not", async () => {
    const { order } = await newOrder(member);
    const file = await storeFully(member, order, sha("5"));
    for (const u of [member, owner, admin]) expect(await sees(u, file.id), u.email).toBe(1);
    for (const u of [other, outsider]) expect(await sees(u, file.id), u.email).toBe(0);
  });

  it("is kept: nobody deletes a confirmed one; an owner or admin removes a waiting row, which gives its count back", async () => {
    await resetCount();
    const { order } = await newOrder(member);
    const waiting = await call(member, order, sha("6"));
    const waitingId = (await row(order)).id;
    expect(waiting.status).toBe("upload");
    expect(await produced()).toBe(1);
    expect(await remove(member, waitingId)).toBe(0);
    expect(await remove(admin, waitingId)).toBe(1);
    expect(await produced()).toBe(0);
    const file = await storeFully(member, order, sha("6"));
    expect(await produced()).toBe(1);
    for (const u of [owner, admin, member]) expect(await remove(u, file.id), u.email).toBe(0);
    expect((await pgError(asAdmin((q) => q("delete from public.files where id = $1", [file.id])))).hint).toBe("file:kept");
  });

  it("counts against max_pdf_per_month (a full month refuses a new PDF, 30 a minute) with one notice at 80%", async () => {
    await resetCount();
    await setLimit(2);
    try {
      await storeFully(owner, (await newOrder(owner)).order, sha("7"));
      expect(await produced()).toBe(1);
      await storeFully(owner, (await newOrder(owner)).order, sha("7"));
      expect(await produced()).toBe(2);
      const third = await newOrder(owner);
      expect((await pgError(call(owner, third.order))).hint).toBe("limit:max_pdf_per_month");
      expect(await produced()).toBe(2);
      expect(await asAdmin((q) => count(q, "select 1 from public.files where order_id = $1", [third.order]))).toBe(0);
      // one notice, to each active owner and admin (the owner and the admin here)
      const notices = await asAdmin(async (q) =>
        (
          await q<{ user_id: string }>(
            "select user_id from public.notifications where organization_id = $1 and type = 'system' and title like 'קובצי ה-PDF הגיעו ל-80%' order by user_id",
            [org],
          )
        ).rows.map((r) => r.user_id),
      );
      expect(notices).toEqual([owner.id, admin.id].sort());
    } finally {
      await setLimit(1000);
    }
    await resetCount();
    await asAdmin((q) => q("update app.pdf_months set minute_start = now(), minute_count = 30 where organization_id = $1 and month = app.automation_run_month($1)", [org]));
    expect((await pgError(call(owner, (await newOrder(owner)).order))).hint).toBe("rate:pdf");
    await resetCount();
  });

  it("the customer downloads the stored file; the page says when there is one; a cancelled order serves none", async () => {
    const { order } = await newOrder(member);
    const token = await link(member, order);
    expect(await download(token)).toEqual({ unavailable: true });
    expect((await page(token)).pdf).toBe(false);
    const file = await storeFully(member, order, sha("e"));
    expect((await page(token)).pdf).toBe(true);
    const answer = await download(token, "ip-1");
    expect(answer).toEqual({ path: file.path, sha256: sha("e"), name: "אישור הזמנה.pdf" });
    expect(Object.keys(answer).sort()).toEqual(["name", "path", "sha256"]);
    // a moved order (in progress) still serves it
    await run(member, (q) => q("update public.orders set status = 'in_progress' where id = $1", [order]));
    expect((await download(token)).sha256).toBe(sha("e"));
    // unknown, malformed
    expect((await pgError(download("x".repeat(64)))).code).toBe("P0002");
    expect((await pgError(download("bad"))).code).toBe("P0002");
    // closed public pages / no flag: not found
    await setFeatures(org, { orders: false });
    try {
      expect((await pgError(download(token))).code).toBe("P0002");
    } finally {
      await setFeatures(org, { orders: true });
    }
    // cancelled: a status page, no file (the file stays kept)
    await run(member, (q) => q("update public.orders set status = 'cancelled' where id = $1", [order]));
    expect(await download(token)).toEqual({ unavailable: true });
    expect(await sees(member, file.id)).toBe(1);
    // a revoked link gets nothing
    await run(member, (q) => q("select public.order_link_revoke($1, $2)", [org, order]));
    expect((await pgError(download(token))).code).toBe("P0002");
  });

  it("another business's order is never served through this business's token, and the other way round", async () => {
    const theirs = await newOrder(outsider, otherOrg);
    const theirToken = await link(outsider, theirs.order, otherOrg);
    const theirFile = await storeFully(outsider, theirs.order, sha("8"), otherOrg);
    const mine = await newOrder(owner);
    const myToken = await link(owner, mine.order);
    await storeFully(owner, mine.order, sha("1"));
    expect((await download(myToken)).sha256).toBe(sha("1"));
    expect(await download(theirToken)).toMatchObject({ path: theirFile.path, sha256: sha("8") });
    expect((await download(theirToken)).path!.startsWith(`${otherOrg}/`)).toBe(true);
  });

  it("limits downloads per sender and per link", async () => {
    const { order } = await newOrder(owner);
    const token = await link(owner, order);
    await storeFully(owner, order, sha("4"));
    await resetWindows(order);
    for (let i = 0; i < 20; i += 1) expect((await download(token, "ip-a")).rate_limited, `try ${i}`).toBeUndefined();
    expect(await download(token, "ip-a")).toEqual({ rate_limited: true });
    expect((await download(token, "ip-b")).sha256).toBe(sha("4"));
    // the link's window is shared with the page: 120 in 10 minutes
    await resetWindows(order);
    await asAdmin((q) => q("update app.order_links set window_count = 120, window_started_at = now() where order_id = $1", [order]));
    expect(await download(token, "ip-c")).toEqual({ rate_limited: true });
    expect(await download(token)).toEqual({ rate_limited: true });
  });

  it("a file is never an order's and a quote's at once (files_one_subject)", async () => {
    const { order } = await newOrder(owner);
    const quote = await run(owner, async (q) => {
      const c = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'לקוח') returning id", [org])).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, c])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    const err = await pgError(
      asAdmin((q) =>
        q("insert into public.files (organization_id, order_id, quote_id, name, mime_type, size_bytes) values ($1, $2, $3, 'x.pdf', 'application/pdf', 1)", [org, order, quote]),
      ),
    );
    expect(err.code).toBe("23514");
    expect(err.message).toContain("files_one_subject");
  });

  it("storage: an owner or admin removes the object of an order's waiting PDF, a member does not; never a confirmed one's", async () => {
    const { order } = await newOrder(member);
    const first = await call(member, order, sha("7"));
    await putObject(first.path!);
    const del = (u: U, path: string) => run(u, async (q) => (await q("delete from storage.objects where bucket_id = 'record-files' and name = $1", [path])).rowCount);
    expect(await del(member, first.path!)).toBe(0);
    expect(await del(other, first.path!)).toBe(0);
    expect(await del(admin, first.path!)).toBe(1);
    // confirmed: nobody removes its object
    await putObject(first.path!);
    expect((await call(member, order, sha("7"), org, 20000, first.path!)).status).toBe("stored");
    for (const u of [owner, admin, member]) expect(await del(u, first.path!), u.email).toBe(0);
  });

  it("a privacy erasure through the order's deal, and through its company, removes its PDF too", async () => {
    // a deal's order
    const viaDeal = await run(owner, async (q) => {
      const pipe = await one<{ p: string; s: string }>(
        q,
        "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1",
        [org],
      );
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'דן', $2) returning id", [org, owner.id])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [
          org,
          pipe.p,
          pipe.s,
          owner.id,
          contact,
        ])
      ).id;
      const order = (await one<{ id: string }>(q, "insert into public.orders (organization_id, deal_id) values ($1, $2) returning id", [org, deal])).id;
      await q("insert into public.order_lines (organization_id, order_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, order]);
      await q("select public.order_confirm($1, $2)", [org, order]);
      return { deal, order };
    });
    // a company's order
    const viaCompany = await run(owner, async (q) => {
      const company = (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, 'חברה בע\"מ', $2) returning id", [org, owner.id])).id;
      const order = (await one<{ id: string }>(q, "insert into public.orders (organization_id, company_id) values ($1, $2) returning id", [org, company])).id;
      await q("insert into public.order_lines (organization_id, order_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, order]);
      await q("select public.order_confirm($1, $2)", [org, order]);
      return { company, order };
    });
    const dealFile = await storeFully(owner, viaDeal.order, sha("a"));
    const companyFile = await storeFully(owner, viaCompany.order, sha("b"));
    await run(owner, async (q) => {
      await q("update public.deals set deleted_at = now() where id = $1", [viaDeal.deal]);
      await q("delete from public.deals where id = $1", [viaDeal.deal]);
      await q("update public.companies set deleted_at = now() where id = $1", [viaCompany.company]);
      await q("delete from public.companies where id = $1", [viaCompany.company]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = any($1)", [[dealFile.id, companyFile.id]]))).toBe(2);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'deals', $2)", [org, viaDeal.deal]));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [dealFile.id]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [companyFile.id]))).toBe(1);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'companies', $2)", [org, viaCompany.company]));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [companyFile.id]))).toBe(0);
    expect(await queued(dealFile.path)).toBe(1);
    expect(await queued(companyFile.path)).toBe(1);
  });

  it("a privacy erasure of the order's contact removes its PDF; the object goes to the orphan cleanup", async () => {
    const { contact, order } = await newOrder(member);
    const file = await storeFully(member, order, sha("2"));
    // the purge alone keeps it (the order is detached and still the business's)
    await run(owner, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [contact]);
      await q("delete from public.contacts where id = $1", [contact]);
    });
    expect(await sees(owner, file.id)).toBe(1);
    expect(await remove(owner, file.id)).toBe(0);
    // a session setting naming another business does not open it either
    expect(
      (
        await pgError(
          asAdmin(async (q) => {
            await q("select set_config('app.order_pdf_erase', $1, true)", ["00000000-0000-0000-0000-000000000000"]);
            await q("delete from public.files where id = $1", [file.id]);
          }),
        )
      ).hint,
    ).toBe("file:kept");
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [file.id]))).toBe(0);
    expect(await queued(file.path)).toBe(1);
    // the order itself stays
    expect(await asAdmin((q) => count(q, "select 1 from public.orders where id = $1", [order]))).toBe(1);
  });
});
