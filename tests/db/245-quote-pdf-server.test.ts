import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Store = { status: string; path?: string; file_id?: string };
type Pdf = { path?: string; sha256?: string; name?: string; unavailable?: boolean; rate_limited?: boolean };

/**
 * QUO-06 follow-ups (owner, 26 October 2026, answers (3) and (1); CLAUDE.md hard rule 5):
 * (3) only the server writes a quote's PDF, through public.quote_pdf_store (service_role only), after the person's right is
 *     checked with their own session (public.quote_pdf_allowed) and again for that user inside the function; the file's
 *     SHA-256 is kept on the row, server-only; authenticated can neither insert the row nor put its object.
 * (1) the customer downloads the stored PDF of the version the link shows, through public.quote_public_pdf (service_role
 *     only): the rules of quote_public, a per-link and a per-sender window, counted as a view, only path, SHA-256 and name.
 */
describe("server-written quote PDFs and the customer's download (QUO-06 follow-ups)", () => {
  let owner: U, admin: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, outsiderOrg: string;
  let pipe: { pipelineId: string; stageId: string };
  let outsiderPipe: { pipelineId: string; stageId: string };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const sha = (c: string) => c.repeat(64);

  const newQuote = (u: U, orgId = org, p = pipe, send = true) =>
    asUser(u.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          orgId,
          p.pipelineId,
          p.stageId,
          u.id,
        ])
      ).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [orgId, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [orgId, id]);
      if (send) await q("select public.quote_send($1, $2)", [orgId, id]);
      return id;
    });
  const call = (u: U, quoteId: string, digest = sha("a"), orgId = org, size = 20000) =>
    asService(
      async (q) =>
        (await one<{ r: Store }>(q, "select public.quote_pdf_store($1, $2, $3, $4, $5, 'הצעה.pdf') as r", [orgId, quoteId, u.id, size, digest])).r,
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
  const storeFully = async (u: U, quoteId: string, digest = sha("a"), orgId = org) => {
    const first = await call(u, quoteId, digest, orgId);
    expect(first.status).toBe("upload");
    await putObject(first.path!);
    const second = await call(u, quoteId, digest, orgId);
    expect(second.status).toBe("stored");
    return { id: second.file_id!, path: first.path! };
  };
  const link = (u: U, quoteId: string, orgId = org) =>
    asUser(u.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [orgId, quoteId])).t);
  const download = (token: string, ip: string | null = null) =>
    asService(async (q) => (await one<{ p: Pdf }>(q, "select public.quote_public_pdf($1, $2) as p", [token, ip])).p);
  const page = (token: string) => asService(async (q) => (await one<{ p: Record<string, unknown> }>(q, "select public.quote_public($1) as p", [token])).p);
  const allowed = (u: U, quoteId: string, orgId = org) =>
    asUser(u.id, async (q) => (await one<{ a: boolean }>(q, "select public.quote_pdf_allowed($1, $2) as a", [orgId, quoteId])).a);
  const resetWindows = (quoteId: string) =>
    asAdmin(async (q) => {
      await q("update app.quote_links set window_count = 0, window_started_at = null where quote_id = $1", [quoteId]);
      await q("update app.quote_pdf_download_counts set downloads = 0 where quote_id = $1", [quoteId]);
    });

  beforeAll(async () => {
    owner = await createUser("qps-owner");
    org = await createOrg(owner.id, "עסק ההצעות");
    admin = await addMember(org, owner.id, "admin", "qps-admin");
    member = await addMember(org, owner.id, "member", "qps-member");
    other = await addMember(org, owner.id, "member", "qps-other");
    viewer = await addMember(org, owner.id, "viewer", "qps-viewer");
    outsider = await createUser("qps-outsider");
    outsiderOrg = await createOrg(outsider.id, "עסק אחר");
    for (const [o, u] of [
      [org, owner],
      [outsiderOrg, outsider],
    ] as const) {
      await asUser(u.id, (q) =>
        q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [o]),
      );
      await asAdmin((q) =>
        q("update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{\"max_pdf_per_month\": 1000}'::jsonb where organization_id = $1", [o]),
      );
    }
    const p = await defaultPipeline(org);
    pipe = { pipelineId: p.pipelineId, stageId: p.stages.find((s) => s.kind === "open")!.id };
    const op = await defaultPipeline(outsiderOrg);
    outsiderPipe = { pipelineId: op.pipelineId, stageId: op.stages.find((s) => s.kind === "open")!.id };
  });

  it("the write and download functions are for service_role only; the right check is for signed-in people", async () => {
    const id = await newQuote(owner);
    for (const fn of [
      "public.quote_pdf_store(uuid, uuid, uuid, bigint, text, text, text)",
      "public.quote_public_pdf(text, text)",
      "public.quote_pdf_allowed(uuid, uuid)",
    ]) {
      const can = async (role: string) =>
        (await asAdmin((q) => one<{ c: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as c", [role, fn]))).c;
      const serviceOnly = fn !== "public.quote_pdf_allowed(uuid, uuid)";
      expect(await can("anon"), fn).toBe(false);
      expect(await can("authenticated"), fn).toBe(!serviceOnly);
      if (serviceOnly) expect(await can("service_role"), fn).toBe(true);
    }
    expect((await pgError(asUser(owner.id, (q) => q("select public.quote_pdf_store($1, $2, $3, 1, $4, 'x.pdf')", [org, id, owner.id, sha("a")])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.quote_pdf_store($1, $2, $3, 1, $4, 'x.pdf')", [org, id, owner.id, sha("a")])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select public.quote_public_pdf('x', null)")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.quote_public_pdf('x', null)")))).code).toBe("42501");
    for (const u of [owner, outsider]) {
      expect((await pgError(asUser(u.id, (q) => q("select * from app.quote_pdf_download_counts")))).code, u.email).toBe("42501");
    }
  });

  it("asks the person's right with their own session: editors yes, others no", async () => {
    const id = await newQuote(member);
    expect(await allowed(member, id)).toBe(true);
    expect(await allowed(owner, id)).toBe(true);
    expect(await allowed(admin, id)).toBe(true);
    expect(await allowed(other, id)).toBe(false);
    expect(await allowed(viewer, id)).toBe(false);
    expect(await allowed(outsider, id)).toBe(false);
    expect(await allowed(outsider, id, outsiderOrg)).toBe(false);
    const draft = await newQuote(member, org, pipe, false);
    expect(await allowed(member, draft)).toBe(false);
  });

  it("checks the user again inside the function; never across businesses", async () => {
    const id = await newQuote(member);
    for (const u of [other, viewer, outsider]) expect((await pgError(call(u, id))).code, u.email).toBe("42501");
    // the outsider's own quote named under this business, and this quote named under the outsider's business
    const theirs = await newQuote(outsider, outsiderOrg, outsiderPipe);
    expect((await pgError(call(owner, theirs))).code).toBe("42501");
    expect((await pgError(call(outsider, id, sha("a"), outsiderOrg))).code).toBe("42501");
    expect((await pgError(call(owner, theirs, sha("a"), outsiderOrg))).code).toBe("42501");
    expect(await asAdmin((q) => count(q, "select 1 from public.files where quote_id = any($1)", [[id, theirs]]))).toBe(0);
    // a suspended member loses it
    const mine = await newQuote(other);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, other.id]));
    try {
      expect((await pgError(call(other, mine))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, other.id]));
    }
    // bad details are refused before anything
    expect((await pgError(call(owner, id, "not-a-sha"))).hint).toBe("quote_pdf:invalid");
    expect((await pgError(call(owner, id, sha("a"), org, 0))).hint).toBe("quote_pdf:invalid");
  });

  it("authenticated can no longer write a quote's row or its object", async () => {
    const id = await newQuote(owner);
    expect(
      (
        await pgError(
          asUser(owner.id, (q) => q("insert into public.files (organization_id, quote_id, name, mime_type, size_bytes) values ($1, $2, 'x.pdf', 'application/pdf', 1)", [org, id])),
        )
      ).code,
    ).toBe("42501");
    expect(await asAdmin((q) => one<{ c: boolean }>(q, "select has_column_privilege('authenticated', 'public.files', 'quote_id', 'insert') as c"))).toEqual({ c: false });
    expect(await asAdmin((q) => one<{ c: boolean }>(q, "select has_column_privilege('authenticated', 'public.files', 'sha256', 'insert') as c"))).toEqual({ c: false });
    // the server's waiting row: the editor cannot put the object there, even if the row named them
    const first = await call(owner, id);
    await asAdmin((q) => q("update public.files set uploaded_by = $2 where quote_id = $1", [id, owner.id]));
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [first.path])))).code,
    ).toBe("42501");
  });

  const callAt = (u: U, quoteId: string, digest: string, path: string | null) =>
    asService(
      async (q) =>
        (
          await one<{ r: Store }>(q, "select public.quote_pdf_store($1, $2, $3, 20000, $4, 'הצעה.pdf', $5) as r", [org, quoteId, u.id, digest, path])
        ).r,
    );
  const rowPath = (quoteId: string) =>
    asAdmin(async (q) => (await one<{ p: string; s: string; u: Date | null }>(q, "select storage_path as p, sha256 as s, unconfirmed_since as u from public.files where quote_id = $1", [quoteId])));
  const queued = (path: string) => asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1 and bucket = 'record-files'", [path]));

  it("every attempt writes to its own path; a stale upload never lands on the confirmed one (review M1)", async () => {
    const id = await newQuote(owner);
    const first = await call(owner, id, sha("b"));
    expect(first).toEqual({ status: "upload", path: expect.stringMatching(new RegExp(`^${org}/`)) });
    const p1 = first.path!;
    // not there yet: the same path again
    expect(await callAt(owner, id, sha("b"), p1)).toEqual(first);
    // something of the wrong size on it: that path is abandoned (queued for the cleanup) and the attempt gets a fresh one
    await putObject(p1, 999);
    const moved = await callAt(owner, id, sha("b"), p1);
    expect(moved.status).toBe("upload");
    const p2 = moved.path!;
    expect(p2).not.toBe(p1);
    expect(p2.startsWith(`${org}/`)).toBe(true);
    expect(await queued(p1)).toBe(1);
    // another render while this one is on its way: busy
    expect(await callAt(owner, id, sha("c"), null)).toEqual({ status: "busy" });
    // after two minutes it is taken over, on a fresh path, with its own fingerprint; the abandoned path is queued
    await asAdmin((q) => q("update public.files set upload_checked_at = now() - interval '3 minutes' where quote_id = $1", [id]));
    const taken = await callAt(owner, id, sha("c"), null);
    const p3 = taken.path!;
    expect(taken.status).toBe("upload");
    expect([p1, p2]).not.toContain(p3);
    expect(await queued(p2)).toBe(1);
    expect(await rowPath(id)).toMatchObject({ p: p3, s: sha("c") });
    // the old render uploads late to its own path and calls again: busy, and its object is queued, never confirmed
    await putObject(p2);
    expect(await callAt(owner, id, sha("b"), p2)).toEqual({ status: "busy" });
    expect(await rowPath(id)).toMatchObject({ p: p3, u: expect.any(Date) });
    // the holder's object: confirmed, and the path stays fixed from then on
    await putObject(p3);
    const done = await callAt(owner, id, sha("c"), p3);
    expect(done.status).toBe("stored");
    expect(await queued(p3)).toBe(0);
    expect(await callAt(owner, id, sha("b"), p1)).toEqual(done);
    expect(await callAt(owner, id, sha("d"), null)).toEqual(done);
    expect(await rowPath(id)).toMatchObject({ p: p3, s: sha("c"), u: null });
    // a path of another business, or one a file uses, is never queued
    const theirs = await newQuote(outsider, outsiderOrg, outsiderPipe);
    await storeFully(outsider, theirs, sha("e"), outsiderOrg);
    const theirPath = (await rowPath(theirs)).p;
    expect(await callAt(owner, id, sha("b"), theirPath)).toEqual(done);
    expect(await queued(theirPath)).toBe(0);
    // the fingerprint is readable with the file (it is not a secret) and server-written only
    expect(await asUser(owner.id, (q) => one<{ s: string }>(q, "select sha256 as s from public.files where id = $1", [done.file_id]))).toEqual({ s: sha("c") });
    expect((await pgError(asUser(owner.id, (q) => q("update public.files set sha256 = $2 where id = $1", [done.file_id, sha("d")])))).code).toBe("42501");
  });

  it("a non-PDF object on the attempt's path is never confirmed", async () => {
    const id = await newQuote(owner);
    const first = await call(owner, id, sha("f"));
    await putObject(first.path!, 20000, "image/png");
    const again = await callAt(owner, id, sha("f"), first.path!);
    expect(again.status).toBe("upload");
    expect(again.path).not.toBe(first.path);
    expect((await rowPath(id)).u).not.toBeNull();
  });

  it("the nightly confirmation never confirms a quote's server row; only quote_pdf_store does (review M2)", async () => {
    const id = await newQuote(owner);
    const first = await call(owner, id, sha("9"));
    await putObject(first.path!);
    await asAdmin((q) =>
      q("update public.files set unconfirmed_since = now() - interval '20 minutes', upload_checked_at = null where quote_id = $1", [id]),
    );
    await asAdmin((q) => q("select app.reconcile_pending_files(5000)"));
    expect((await rowPath(id)).u).not.toBeNull();
    // the server's own call confirms it
    expect((await callAt(owner, id, sha("9"), first.path!)).status).toBe("stored");
  });

  it("the customer downloads the shown version's stored file, counted as a view; the page says when there is one", async () => {
    const id = await newQuote(member);
    const token = await link(member, id);
    // no file yet
    expect(await download(token)).toEqual({ unavailable: true });
    expect((await page(token)).pdf).toBe(false);
    const views = () => asAdmin(async (q) => (await q<{ c: number }>("select view_count as c from public.quote_views where quote_id = $1", [id])).rows[0]?.c ?? 0);
    const before = await views();
    const file = await storeFully(member, id, sha("e"));
    expect((await page(token)).pdf).toBe(true);
    const before2 = await views();
    expect(before2).toBe(before + 1);
    const answer = await download(token, "ip-1");
    expect(answer).toEqual({ path: file.path, sha256: sha("e"), name: "הצעה.pdf" });
    expect(Object.keys(answer).sort()).toEqual(["name", "path", "sha256"]);
    expect(await views()).toBe(before2 + 1);
    expect(await asAdmin((q) => one<{ s: string }>(q, "select status as s from public.quotes where id = $1", [id]))).toEqual({ s: "viewed" });
    // an unknown or malformed token
    expect((await pgError(download("x".repeat(64)))).code).toBe("P0002");
    expect((await pgError(download("bad"))).code).toBe("P0002");
    // a revoked link gets nothing
    await asUser(member.id, (q) => q("select public.quote_link_revoke($1, $2)", [org, id]));
    expect((await pgError(download(token))).code).toBe("P0002");
  });

  it("follows the link's display rules: a newer sent version, a status page, a closed business", async () => {
    const id = await newQuote(owner);
    const token = await link(owner, id);
    await storeFully(owner, id, sha("f"));
    // a newer version, still a draft: the old version is still the one shown
    const v2 = await asUser(owner.id, async (q) => (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, id])).v);
    expect((await download(token)).sha256).toBe(sha("f"));
    // sent: the link shows it, and it has no file yet, so the old file is never served in its place
    await asUser(owner.id, (q) => q("select public.quote_send($1, $2)", [org, v2]));
    expect(await download(token)).toEqual({ unavailable: true });
    const newer = await storeFully(owner, v2, sha("1"));
    expect(await download(token)).toMatchObject({ path: newer.path, sha256: sha("1") });
    // cancelled: a status page, no file
    await asUser(owner.id, (q) => q("select public.quote_cancel($1, $2)", [org, v2]));
    expect(await download(token)).toEqual({ unavailable: true });
    // public pages closed / no flag: not found
    const third = await newQuote(owner);
    const t3 = await link(owner, third);
    await storeFully(owner, third, sha("2"));
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"quotes\": false}'::jsonb where organization_id = $1", [org]));
    try {
      expect((await pgError(download(t3))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'quotes' where organization_id = $1", [org]));
    }
    expect((await download(t3)).sha256).toBe(sha("2"));
  });

  it("an accepted quote keeps its file; a quote without a fingerprinted file serves none", async () => {
    const id = await newQuote(owner);
    const token = await link(owner, id);
    await storeFully(owner, id, sha("3"));
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [id]));
    expect((await download(token)).sha256).toBe(sha("3"));
    // a file written before the fingerprint existed is not served to the customer
    const old = await newQuote(owner);
    const oldToken = await link(owner, old);
    await asAdmin((q) =>
      q("insert into public.files (organization_id, quote_id, name, mime_type, size_bytes) values ($1, $2, 'x.pdf', 'application/pdf', 1)", [org, old]),
    );
    expect(await asAdmin((q) => one<{ u: Date | null }>(q, "select unconfirmed_since as u from public.files where quote_id = $1", [old]))).toEqual({ u: null });
    expect(await download(oldToken)).toEqual({ unavailable: true });
    expect((await page(oldToken)).pdf).toBe(false);
  });

  it("limits downloads per sender and per link", async () => {
    const id = await newQuote(owner);
    const token = await link(owner, id);
    await storeFully(owner, id, sha("4"));
    await resetWindows(id);
    for (let i = 0; i < 20; i += 1) expect((await download(token, "ip-a")).rate_limited, `try ${i}`).toBeUndefined();
    expect(await download(token, "ip-a")).toEqual({ rate_limited: true });
    // another sender still downloads; no hash is kept, only buckets
    expect((await download(token, "ip-b")).sha256).toBe(sha("4"));
    expect(await asAdmin((q) => count(q, "select 1 from app.quote_pdf_download_counts where quote_id = $1", [id]))).toBeGreaterThan(0);
    // the link's window is shared with the page: 120 in 10 minutes
    await resetWindows(id);
    await asAdmin((q) => q("update app.quote_links set window_count = 120, window_started_at = now() where quote_id = $1", [id]));
    expect(await download(token, "ip-c")).toEqual({ rate_limited: true });
    expect(await download(token)).toEqual({ rate_limited: true });
  });
});
