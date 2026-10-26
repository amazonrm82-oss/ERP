import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Store = { status: string; path?: string; file_id?: string };
type Pdf = { path?: string; sha256?: string; name?: string; unavailable?: boolean; rate_limited?: boolean };

/**
 * QUO-06 follow-up (owner, 26 October 2026, answer 1 (ג)): a quote PDF stored by the old flow (no files.sha256) is made again
 * by the server once, through public.quote_pdf_store: the same row moves to a fresh path with the new SHA-256, the old object
 * goes to the orphan cleanup, nothing is counted in max_pdf_per_month, and app.quote_pdf_remakes marks it done for good.
 */
describe("a quote PDF without a fingerprint is made again once (QUO-06 follow-up)", () => {
  let owner: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, outsiderOrg: string;
  let pipe: { pipelineId: string; stageId: string };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const sha = (c: string) => c.repeat(64);

  const newQuote = (u: U, send = true) =>
    asUser(u.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipe.pipelineId,
          pipe.stageId,
          u.id,
        ])
      ).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, id]);
      if (send) await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
  // a PDF as the old flow kept it: a confirmed row at `<org>/<file id>` with no SHA-256, and its object
  const legacyPdf = async (quoteId: string) => {
    const row = await asAdmin((q) =>
      one<{ id: string; storage_path: string }>(
        q,
        "insert into public.files (organization_id, quote_id, name, mime_type, size_bytes) values ($1, $2, 'ישן.pdf', 'application/pdf', 1000) returning id, storage_path",
        [org, quoteId],
      ),
    );
    await putObject(row.storage_path, 1000);
    return row;
  };
  const callAt = (u: U, quoteId: string, digest: string, path: string | null, size = 20000) =>
    asService(
      async (q) =>
        (await one<{ r: Store }>(q, "select public.quote_pdf_store($1, $2, $3, $4, $5, 'הצעה.pdf', $6) as r", [org, quoteId, u.id, size, digest, path])).r,
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
  const row = (quoteId: string) =>
    asAdmin((q) =>
      one<{ id: string; p: string; s: string | null; size: string; n: number }>(
        q,
        "select id, storage_path as p, sha256 as s, size_bytes::text as size, (select count(*)::int from public.files x where x.quote_id = $1) as n from public.files where quote_id = $1",
        [quoteId],
      ),
    );
  const queued = (path: string) => asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1 and bucket = 'record-files'", [path]));
  const produced = () =>
    asAdmin(async (q) => (await one<{ n: number }>(q, "select coalesce(sum(produced), 0)::int as n from app.pdf_months where organization_id = $1", [org])).n);
  const remakeAllowed = (u: U, quoteId: string, orgId = org) =>
    asUser(u.id, async (q) => (await one<{ a: boolean }>(q, "select public.quote_pdf_remake_allowed($1, $2) as a", [orgId, quoteId])).a);
  const unthrottle = (fileId: string) => asAdmin((q) => q("update app.quote_pdf_remakes set last_attempt_at = null where file_id = $1", [fileId]));
  const link = (u: U, quoteId: string) => asUser(u.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quoteId])).t);
  const download = (token: string) => asService(async (q) => (await one<{ p: Pdf }>(q, "select public.quote_public_pdf($1, null) as p", [token])).p);

  beforeAll(async () => {
    owner = await createUser("qpr-owner");
    org = await createOrg(owner.id, "עסק ההצעות");
    member = await addMember(org, owner.id, "member", "qpr-member");
    other = await addMember(org, owner.id, "member", "qpr-other");
    viewer = await addMember(org, owner.id, "viewer", "qpr-viewer");
    outsider = await createUser("qpr-outsider");
    outsiderOrg = await createOrg(outsider.id, "עסק אחר");
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    await asAdmin((q) =>
      q("update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{\"max_pdf_per_month\": 1000}'::jsonb where organization_id = $1", [org]),
    );
    const p = await defaultPipeline(org);
    pipe = { pipelineId: p.pipelineId, stageId: p.stages.find((s) => s.kind === "open")!.id };
  });

  it("the right check is for signed-in people; the job table is out of the API", async () => {
    const can = async (role: string) =>
      (await asAdmin((q) => one<{ c: boolean }>(q, "select has_function_privilege($1, 'public.quote_pdf_remake_allowed(uuid, uuid)', 'execute') as c", [role]))).c;
    expect(await can("anon")).toBe(false);
    expect(await can("authenticated")).toBe(true);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const sig of [
        "app.quote_pdf_remake(public.quotes, public.files, uuid, bigint, text, text, text)",
        "app.quote_pdf_remake_sweep(integer)",
        "app.quote_pdf_remakes_gone()",
      ]) {
        const fn = await asAdmin((q) => one<{ c: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as c", [role, sig]));
        expect(fn.c, `${role} ${sig}`).toBe(false);
      }
    }
    expect((await pgError(asUser(owner.id, (q) => q("select * from app.quote_pdf_remakes")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.quote_pdf_remake_allowed($1, $1)", [org])))).code).toBe("42501");
  });

  it("asks the person's right: an editor of a non-draft quote that holds a PDF without a fingerprint", async () => {
    const id = await newQuote(member);
    expect(await remakeAllowed(member, id)).toBe(false); // no PDF yet
    const file = await legacyPdf(id);
    expect(await remakeAllowed(member, id)).toBe(true);
    await unthrottle(file.id);
    expect(await remakeAllowed(owner, id)).toBe(true);
    await unthrottle(file.id);
    expect(await remakeAllowed(other, id)).toBe(false);
    expect(await remakeAllowed(viewer, id)).toBe(false);
    expect(await remakeAllowed(outsider, id)).toBe(false);
    expect(await remakeAllowed(outsider, id, outsiderOrg)).toBe(false);
    // the quote need not be open any more: the file exists already
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [id]));
    expect(await remakeAllowed(member, id)).toBe(true);
  });

  it("review L1: a render starts at most once a minute per file, never while an attempt is on its way or done", async () => {
    const id = await newQuote(owner);
    const file = await legacyPdf(id);
    expect(await remakeAllowed(owner, id)).toBe(true);
    // the same minute: no second render, for anyone
    expect(await remakeAllowed(owner, id)).toBe(false);
    expect(await remakeAllowed(member, id)).toBe(false);
    await unthrottle(file.id);
    // an attempt on its way (two minutes) is not rendered again
    const first = await callAt(owner, id, sha("7"), null);
    expect(first.status).toBe("upload");
    expect(await remakeAllowed(owner, id)).toBe(false);
    await asAdmin((q) => q("update app.quote_pdf_remakes set started_at = now() - interval '3 minutes' where file_id = $1", [file.id]));
    expect(await remakeAllowed(owner, id)).toBe(true);
    // done: never again
    await unthrottle(file.id);
    const again = await callAt(owner, id, sha("7"), null);
    await putObject(again.path!);
    expect((await callAt(owner, id, sha("7"), again.path!)).status).toBe("stored");
    await unthrottle(file.id);
    expect(await remakeAllowed(owner, id)).toBe(false);
    // the claim answers members of the business only, about its own quote PDFs
    const claim = (u: U, o: string) =>
      asUser(u.id, async (q) => (await one<{ c: boolean }>(q, "select app.quote_pdf_remake_claim($1, $2) as c", [o, file.id])).c);
    expect(await claim(outsider, org)).toBe(false);
    expect(await claim(outsider, outsiderOrg)).toBe(false);
    expect((await pgError(asAnon((q) => q("select app.quote_pdf_remake_claim($1, $1)", [org]))))).toBeTruthy();
  });

  it("review L2: a finished remake writes one audit entry with the sizes only", async () => {
    const id = await newQuote(owner);
    const file = await legacyPdf(id);
    const first = await callAt(owner, id, sha("8"), null);
    await putObject(first.path!);
    await callAt(owner, id, sha("8"), first.path!);
    const entries = await asAdmin(async (q) =>
      (
        await q<{ a: string; e: string; c: Record<string, unknown>; u: string }>(
          "select action as a, entity_type as e, changes as c, actor_id as u from public.audit_log where entity_id = $1 and action = 'pdf_remake'",
          [file.id],
        )
      ).rows,
    );
    expect(entries).toEqual([{ a: "pdf_remake", e: "files", c: { old_size: 1000, new_size: 20000 }, u: owner.id }]);
  });

  it("review M1: an open attempt's path is queued when its file goes, when the customer is erased, and by the nightly sweep", async () => {
    // the file goes (a privacy erasure through app.quote_pdf_drop) while an attempt is open
    const a = await newQuote(owner);
    await legacyPdf(a);
    const pa = (await callAt(owner, a, sha("a"), null)).path!;
    await asAdmin((q) => q("select app.quote_pdf_drop($1, array[$2]::uuid[])", [org, a]));
    expect(await queued(pa)).toBe(1);
    // the customer is erased while an attempt is open: the next call queues it
    const b = await newQuote(owner);
    const fb = await legacyPdf(b);
    const pb = (await callAt(owner, b, sha("b"), null)).path!;
    await asAdmin((q) => q("update public.quotes set customer_deleted_at = now() where id = $1", [b]));
    expect((await callAt(owner, b, sha("b"), pb)).status).toBe("stored");
    expect(await queued(pb)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.quote_pdf_remakes where file_id = $1 and abandoned_at is not null", [fb.id]))).toBe(1);
    // nobody comes back: after a day the sweep queues it and marks the job, which a later attempt starts afresh
    const c = await newQuote(owner);
    const fc = await legacyPdf(c);
    const pc = (await callAt(owner, c, sha("c"), null)).path!;
    expect(await asAdmin((q) => one<{ n: number }>(q, "select app.quote_pdf_remake_sweep() as n"))).toEqual({ n: 0 });
    await asAdmin((q) => q("update app.quote_pdf_remakes set started_at = now() - interval '25 hours' where file_id = $1", [fc.id]));
    expect((await asAdmin((q) => one<{ n: number }>(q, "select app.quote_pdf_remake_sweep() as n"))).n).toBeGreaterThanOrEqual(1);
    expect(await queued(pc)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.quote_pdf_remakes where file_id = $1 and abandoned_at is not null", [fc.id]))).toBe(1);
    // the abandoned path is never confirmed; a new attempt gets a fresh one
    await putObject(pc);
    const fresh = await callAt(owner, c, sha("c"), pc);
    expect(fresh.status).toBe("upload");
    expect(fresh.path).not.toBe(pc);
    await putObject(fresh.path!);
    expect((await callAt(owner, c, sha("c"), fresh.path!)).status).toBe("stored");
    expect(await row(c)).toMatchObject({ p: fresh.path, s: sha("c") });
    // a finished or abandoned job removed with its file queues nothing more
    expect(await asAdmin((q) => count(q, "select 1 from app.quote_pdf_remakes where done_at is null and abandoned_at is null and path is not null and started_at < now() - interval '1 day'"))).toBe(0);
  });

  it("makes the file again once, on the same row, without counting it; the old object is deleted by the cleanup", async () => {
    const id = await newQuote(owner);
    const token = await link(owner, id);
    const old = await legacyPdf(id);
    expect(await download(token)).toEqual({ unavailable: true });
    const before = await produced();

    // another person who may not edit the quote: refused, as for a new file
    expect((await pgError(callAt(other, id, sha("a"), null))).code).toBe("42501");

    const first = await callAt(owner, id, sha("a"), null);
    expect(first.status).toBe("upload");
    const p1 = first.path!;
    expect(p1.startsWith(`${org}/`)).toBe(true);
    expect(p1).not.toBe(old.storage_path);
    // meanwhile the row still serves the old object
    expect(await row(id)).toMatchObject({ id: old.id, p: old.storage_path, s: null, n: 1 });
    // not there yet: the same path again; another render meanwhile is busy
    expect(await callAt(owner, id, sha("a"), p1)).toEqual(first);
    expect(await callAt(owner, id, sha("b"), null)).toEqual({ status: "busy" });

    await putObject(p1);
    expect(await callAt(owner, id, sha("a"), p1)).toEqual({ status: "stored", file_id: old.id });
    expect(await row(id)).toEqual({ id: old.id, p: p1, s: sha("a"), size: "20000", n: 1 });
    // the old object goes to the nightly cleanup (no row removed); the new one is not queued
    expect(await queued(old.storage_path)).toBe(1);
    expect(await queued(p1)).toBe(0);
    // not counted in the quota: not a new version
    expect(await produced()).toBe(before);
    // the customer's link serves it now
    expect(await download(token)).toMatchObject({ path: p1, sha256: sha("a") });

    // once, ever: later calls answer the stored file, a stale upload is queued, nothing moves
    expect(await callAt(owner, id, sha("c"), null)).toEqual({ status: "stored", file_id: old.id });
    const stale = `${org}/${crypto.randomUUID()}`;
    expect(await callAt(owner, id, sha("c"), stale)).toEqual({ status: "stored", file_id: old.id });
    expect(await queued(stale)).toBe(1);
    expect(await remakeAllowed(owner, id)).toBe(false);
    const job = await asAdmin((q) => one<{ d: Date | null; o: string }>(q, "select done_at as d, old_path as o from app.quote_pdf_remakes where file_id = $1", [old.id]));
    expect(job.d).not.toBeNull();
    expect(job.o).toBe(old.storage_path);
    // even if the fingerprint were gone, the marker holds
    await asAdmin((q) => q("update public.files set sha256 = null where id = $1", [old.id]));
    expect(await callAt(owner, id, sha("d"), null)).toEqual({ status: "stored", file_id: old.id });
    expect((await row(id)).p).toBe(p1);
    await asAdmin((q) => q("update public.files set sha256 = $2 where id = $1", [old.id, sha("a")]));
  });

  it("a stale attempt is taken over after two minutes, on a fresh path, and its path is queued", async () => {
    const id = await newQuote(owner);
    const old = await legacyPdf(id);
    const first = await callAt(owner, id, sha("e"), null);
    await asAdmin((q) => q("update app.quote_pdf_remakes set started_at = now() - interval '3 minutes' where file_id = $1", [old.id]));
    const taken = await callAt(owner, id, sha("f"), null);
    expect(taken.status).toBe("upload");
    expect(taken.path).not.toBe(first.path);
    expect(await queued(first.path!)).toBe(1);
    // the first render uploads late and calls again: busy, its own object queued, nothing confirmed
    await putObject(first.path!);
    expect(await callAt(owner, id, sha("e"), first.path!)).toEqual({ status: "busy" });
    expect(await row(id)).toMatchObject({ p: old.storage_path, s: null });
    // something else on the holder's path (wrong size): a fresh path again
    await putObject(taken.path!, 5);
    const again = await callAt(owner, id, sha("f"), taken.path!);
    expect(again.status).toBe("upload");
    expect(again.path).not.toBe(taken.path);
    await putObject(again.path!);
    expect((await callAt(owner, id, sha("f"), again.path!)).status).toBe("stored");
    expect(await row(id)).toMatchObject({ p: again.path, s: sha("f") });
  });

  it("an erased customer's or a draft's file is left as it is", async () => {
    const id = await newQuote(owner);
    const old = await legacyPdf(id);
    await asAdmin((q) => q("update public.quotes set customer_deleted_at = now() where id = $1", [id]));
    expect(await remakeAllowed(owner, id)).toBe(false);
    const stale = `${org}/${crypto.randomUUID()}`;
    expect(await callAt(owner, id, sha("1"), stale)).toEqual({ status: "stored", file_id: old.id });
    expect(await row(id)).toMatchObject({ p: old.storage_path, s: null });
    expect(await queued(stale)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.quote_pdf_remakes where file_id = $1", [old.id]))).toBe(0);
  });

  it("the job goes with its file", async () => {
    const id = await newQuote(owner);
    const old = await legacyPdf(id);
    await callAt(owner, id, sha("2"), null);
    expect(await asAdmin((q) => count(q, "select 1 from app.quote_pdf_remakes where file_id = $1", [old.id]))).toBe(1);
    // the file's removal (a privacy erasure, or the business's own deletion) takes the job by cascade
    const fk = await asAdmin((q) =>
      one<{ d: string }>(q, "select confdeltype as d from pg_constraint where conname = 'quote_pdf_remakes_file_fk'"),
    );
    expect(fk.d).toBe("c");
  });
});
