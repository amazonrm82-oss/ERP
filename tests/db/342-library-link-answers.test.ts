import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, defaultLeadStatus, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Entry = { id: string; type: string; body: string; created_by: string | null; metadata: Record<string, unknown> };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const sender = (n: number) => sha256(`answers-sender-${n}`);

/**
 * LIB-02, the owner's answers of 12 November 2026: (292) ב the rep is told only on the first opening, and each business day
 * with an opening is one `system` entry (kind library_viewed, no author, the item's title only) that no person writes,
 * changes or removes and that is not activity; (293) ב a link item goes through the page before an outside site, from the
 * stored link only (public.library_link_public_link); (294) ב whoever may edit the record may turn a link off; (296) ג a
 * link of a maker who left or no longer reads the record keeps serving, and its first opening tells the owners and admins.
 */
describe("tracked library links: the owner's answers (292)-(296)", () => {
  let owner: U, admin: U, member: U, other: U, third: U, viewer: U, outsider: U;
  let org: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const lead = async (ownerId: string) => {
    const status = await defaultLeadStatus(org);
    return asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.leads (organization_id, status_id, full_name, owner_id, phone, email) values ($1, $2, 'נועה לוי', $3, '050-1112233', 'noa@example.com') returning id", [org, status, ownerId])).id,
    );
  };
  const linkItem = (title: string, url = "https://example.com/catalog") =>
    asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.library_items (organization_id, kind, title, url) values ($1, 'link', $2, $3) returning id", [org, title, url])).id,
    );
  const create = (u: U, item: string, type: string, id: string) =>
    asUser(u.id, async (q) => (await one<{ t: string }>(q, "select public.library_link_create($1, $2, $3, $4) as t", [org, item, type, id])).t);
  const page = (token: string, ip: string | null = sender(++n)) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.library_link_public($1, $2) as r", [token, ip])).r);
  const go = (token: string, ip: string | null = sender(++n)) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.library_link_public_link($1, $2) as r", [token, ip])).r);
  const linkId = (token: string) =>
    asAdmin(async (q) => (await one<{ link_id: string }>(q, "select link_id from app.library_link_secrets where token_hash = $1", [sha256(token)])).link_id);
  const entries = (leadId: string) =>
    asAdmin(async (q) =>
      (await q<Entry>("select id, type, body, created_by, metadata from public.activities where lead_id = $1 and metadata ->> 'kind' = 'library_viewed' order by created_at, id", [leadId])).rows,
    );
  const notices = (u: U) =>
    asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'library_viewed'", [u.id]));
  const nextDay = (token: string) =>
    asAdmin((q) => q("update app.library_link_secrets set notified_on = notified_on - 1 where token_hash = $1", [sha256(token)]));
  const revoke = (u: U, id: string) =>
    asUser(u.id, async (q) => (await one<{ r: boolean }>(q, "select public.library_link_revoke($1, $2) as r", [org, id])).r);

  beforeAll(async () => {
    owner = await createUser("la-owner");
    org = await createOrg(owner.id, "עסק התשובות");
    admin = await addMember(org, owner.id, "admin", "la-admin");
    member = await addMember(org, owner.id, "member", "la-member");
    other = await addMember(org, owner.id, "member", "la-other");
    third = await addMember(org, owner.id, "member", "la-third");
    viewer = await addMember(org, owner.id, "viewer", "la-viewer");
    outsider = await createUser("la-outsider");
    await createOrg(outsider.id, "עסק זר");
  });

  it("(292) ב: one entry a business day with an opening, no author, the item's title only; the rep is told once", async () => {
    const item = await linkItem("קטלוג קיץ");
    const leadId = await lead(member.id);
    const token = await create(member, item, "lead", leadId);
    const told = await notices(member);
    await page(token);
    await page(token);
    await page(token);
    let rows = await entries(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: expect.any(String),
      type: "system",
      body: "הלקוח פתח את הקישור מהספרייה: קטלוג קיץ",
      created_by: null,
      metadata: { kind: "library_viewed", library_link_id: await linkId(token) },
    });
    for (const secret of ["נועה", "050-1112233", "1112233", "noa@"]) expect(JSON.stringify(rows)).not.toContain(secret);
    expect((await notices(member)) - told).toBe(1);
    // the next business day: one more entry, no more notices
    await nextDay(token);
    await page(token);
    await page(token);
    rows = await entries(leadId);
    expect(rows).toHaveLength(2);
    expect((await notices(member)) - told).toBe(1);
    // a rate-limited call writes nothing
    await nextDay(token);
    const ip = sender(70000);
    for (let i = 0; i < 60; i += 1) await page(token, ip);
    expect(await page(token, ip)).toEqual({ rate_limited: true });
    expect(await entries(leadId)).toHaveLength(3);
  });

  it("(292) ב: no person writes, changes or removes such an entry, owners and admins included", async () => {
    const item = await linkItem("פריט שמור");
    const leadId = await lead(member.id);
    const token = await create(member, item, "lead", leadId);
    await page(token);
    const [entry] = await entries(leadId);
    // owners and admins reach system entries through the update and delete policies, so the guard is what stops them; a
    // member's policies never reach the entry (0 rows); nobody forges one
    for (const u of [owner, admin]) {
      const changed = await pgError(asUser(u.id, (q) => q("update public.activities set body = 'שונה' where id = $1", [entry.id])));
      expect(changed.code).toBe("42501");
      expect(changed.hint).toBe("activity:library_entry");
      const removed = await pgError(asUser(u.id, (q) => q("delete from public.activities where id = $1", [entry.id])));
      expect(removed.code).toBe("42501");
      expect(removed.hint).toBe("activity:library_entry");
    }
    expect(await asUser(member.id, async (q) => (await q("update public.activities set body = 'שונה' where id = $1 returning id", [entry.id])).rowCount)).toBe(0);
    for (const u of [owner, admin, member]) {
      const forged = await pgError(
        asUser(u.id, (q) =>
          q("insert into public.activities (organization_id, type, lead_id, body, metadata) values ($1, 'note', $2, 'מזויף', '{\"kind\": \"library_viewed\"}')", [org, leadId]),
        ),
      );
      expect(forged.code).toBe("42501");
    }
    expect(await entries(leadId)).toHaveLength(1);
    expect((await entries(leadId))[0].body).toBe("הלקוח פתח את הקישור מהספרייה: פריט שמור");
  });

  it("(292) ב: the entry is neither contact nor activity", async () => {
    const item = await linkItem("פריט לא פעילות");
    const leadId = await lead(member.id);
    const facts = () =>
      asAdmin(async (q) => (await one<{ f: { last_at: string } }>(q, "select app.automation_run_facts('no_activity', '{}'::jsonb, 'lead', $1, $2, 'x') as f", [org, leadId])).f);
    const before = await facts();
    const token = await create(member, item, "lead", leadId);
    await page(token);
    expect(await entries(leadId)).toHaveLength(1);
    expect(await facts()).toEqual(before);
    expect(
      await asAdmin(async (q) =>
        (await one<{ held: boolean }>(q, "select app.automation_event_still_holds('no_activity', '{}'::jsonb, 'lead', $1, $2, to_jsonb(l), $3::jsonb) as held from public.leads l where l.id = $2", [org, leadId, JSON.stringify(before)])).held,
      ),
    ).toBe(true);
    const contact = await asAdmin(async (q) => one<{ last: string | null }>(q, "select last_contacted_at as last from public.leads where id = $1", [leadId]));
    expect(contact).toEqual({ last: null });
  });

  // (299) ב (021238) refines this: the record's current owner is told first; test 349 covers the owners and admins branch
  it("(296) ג / (299) ב: a maker who no longer reads the record: the record's current owner is told on the first opening, and the link serves", async () => {
    const item = await linkItem("פריט של נציג");
    const leadId = await lead(member.id);
    const token = await create(member, item, "lead", leadId);
    // the record moves to another rep and the business shows each rep only their own
    await asAdmin((q) => q("update public.leads set owner_id = $2 where id = $1", [leadId, other.id]));
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const [m, o, a, x] = [await notices(member), await notices(owner), await notices(admin), await notices(other)];
      expect((await page(token)).item).toMatchObject({ title: "פריט של נציג" });
      await page(token);
      expect(await notices(member)).toBe(m);
      expect(await notices(owner)).toBe(o);
      expect(await notices(admin)).toBe(a);
      expect(await notices(other)).toBe(x + 1);
      const notice = await asAdmin(async (q) =>
        one<{ title: string; body: string; entity_id: string }>(q, "select title, body, entity_id from public.notifications where user_id = $1 and type = 'library_viewed' order by created_at desc limit 1", [other.id]),
      );
      expect(notice).toEqual({ title: "הלקוח פתח קישור שנשלח מהספרייה", body: "פריט של נציג", entity_id: leadId });
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("(294) ב: whoever may edit the record turns a link off; a reader who may not edit cannot; a viewer or outsider never", async () => {
    const item = await linkItem("פריט לביטול");
    const leadId = await lead(other.id);
    const token = await create(member, item, "lead", leadId);
    const id = await linkId(token);
    for (const u of [third, viewer, outsider]) expect((await pgError(revoke(u, id))).code).toBe("42501");
    // read-only: editing is closed, so only the maker or an owner/admin may still turn it off
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(revoke(other, id))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    // the record's owner (not the maker) turns it off
    expect(await revoke(other, id)).toBe(true);
    expect((await pgError(page(token))).code).toBe("P0002");
    const row = await asAdmin(async (q) => one<{ revoked_by: string }>(q, "select revoked_by from public.library_links where id = $1", [id]));
    expect(row.revoked_by).toBe(other.id);
  });

  it("(293) ב: the page before the site answers only the stored link and the business's name, and counts no view", async () => {
    const item = await linkItem("אתר הקטלוג", "https://shop.example.com/catalog?x=1");
    const leadId = await lead(member.id);
    const token = await create(member, item, "lead", leadId);
    const answer = await go(token);
    expect(answer).toEqual({ url: "https://shop.example.com/catalog?x=1", business: "עסק התשובות" });
    const views = await asAdmin(async (q) => one<{ view_count: number }>(q, "select view_count from public.library_links where id = $1", [await linkId(token)]));
    expect(views.view_count).toBe(0);
    expect(await entries(leadId)).toHaveLength(0);
    // the server only
    expect((await pgError(asUser(owner.id, (q) => q("select public.library_link_public_link($1, null)", [token])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.library_link_public_link($1, null)", [token])))).code).toBe("42501");
    // not found: unknown token, a turned-off link, a file item
    expect((await pgError(go("y".repeat(64)))).code).toBe("P0002");
    const fileItem = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.library_items (organization_id, kind, title) values ($1, 'file', 'קובץ') returning id", [org])).id);
    const file = await asUser(owner.id, async (q) =>
      one<{ id: string; storage_path: string }>(q, "insert into public.files (organization_id, library_item_id, name, mime_type, size_bytes) values ($1, $2, 'a.pdf', 'application/pdf', 10) returning id, storage_path", [org, fileItem]),
    );
    await asUser(owner.id, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [file.storage_path]));
    await asAdmin((q) => q("update storage.objects set metadata = jsonb_build_object('size', 10::bigint, 'mimetype', 'application/pdf') where bucket_id = 'record-files' and name = $1", [file.storage_path]));
    await asUser(owner.id, (q) => q("select public.confirm_file_upload($1, $2)", [org, file.id]));
    const fileToken = await create(member, fileItem, "lead", leadId);
    expect((await pgError(go(fileToken))).code).toBe("P0002");
    // it shares the link's counters
    const ip = sender(80000);
    for (let i = 0; i < 60; i += 1) await go(token, ip);
    expect(await go(token, ip)).toEqual({ rate_limited: true });
    expect(await revoke(member, await linkId(token))).toBe(true);
    expect((await pgError(go(token))).code).toBe("P0002");
  });

  it("BIZ-03's emergency switch: while outside links are blocked, /go is not found and counts nothing, and the page offers no link", async () => {
    const item = await linkItem("אתר חסום", "https://blocked.example.com/");
    const leadId = await lead(member.id);
    const token = await create(member, item, "lead", leadId);
    const id = await linkId(token);
    const counters = () =>
      asAdmin(async (q) =>
        one<{ window_count: number; buckets: number; views: number }>(
          q,
          "select s.window_count, (select count(*)::int from app.library_link_view_counts c where c.link_id = s.link_id) as buckets, l.view_count as views from app.library_link_secrets s join public.library_links l on l.id = s.link_id where s.link_id = $1",
          [id],
        ),
      );
    const setBlock = (blocked: boolean) =>
      asAdmin((q) =>
        q(
          "insert into app.qr_external_blocks (organization_id, blocked, reason) values ($1, $2, 'בדיקה') on conflict (organization_id) do update set blocked = excluded.blocked",
          [org, blocked],
        ),
      );
    await setBlock(true);
    try {
      const before = await counters();
      expect((await pgError(go(token))).code).toBe("P0002");
      expect((await pgError(go(token, null))).code).toBe("P0002");
      expect(await counters()).toEqual(before);
      // the page still opens (a view, as before), with no link and the mark that the site is off
      const shown = (await page(token)) as { item: { kind: string; url: string | null; external_blocked: boolean } };
      expect(shown.item).toMatchObject({ kind: "link", url: null, external_blocked: true });
      expect(JSON.stringify(shown)).not.toContain("blocked.example.com");
      expect((await counters()).views).toBe(before.views + 1);
    } finally {
      await setBlock(false);
    }
    expect(await go(token)).toEqual({ url: "https://blocked.example.com/", business: "עסק התשובות" });
    expect(((await page(token)) as { item: { url: string | null; external_blocked: boolean } }).item).toMatchObject({
      url: "https://blocked.example.com/",
      external_blocked: false,
    });
  });

  it("a merge carries the duplicate's library_viewed entries to the kept record past the guard, as other system entries", async () => {
    const item = await linkItem("פריט למיזוג");
    const kept = await lead(owner.id);
    const dup = await lead(owner.id);
    const keptToken = await create(member, item, "lead", kept);
    const dupToken = await create(member, item, "lead", dup);
    await page(keptToken);
    await page(dupToken);
    const dupEntry = (await entries(dup))[0];
    const keptEntry = (await entries(kept))[0];
    // a system entry of another kind on the duplicate, for comparison
    const other = await asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.activities (organization_id, type, lead_id, body, metadata) values ($1, 'system', $2, 'רישום מערכת', '{\"kind\": \"snooze_cleared\"}') returning id", [org, dup])).id,
    );
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}'::jsonb)", [org, kept, dup]));
    const where = (id: string) => asAdmin(async (q) => (await one<{ lead_id: string }>(q, "select lead_id from public.activities where id = $1", [id])).lead_id);
    expect(await where(other)).toBe(kept);
    expect(await where(dupEntry.id)).toBe(kept);
    expect(await where(keptEntry.id)).toBe(kept);
    const after = await entries(kept);
    expect(after.map((e) => e.id).sort()).toEqual([dupEntry.id, keptEntry.id].sort());
    expect(after.every((e) => e.created_by === null && e.type === "system")).toBe(true);
    // both links now belong to the kept record and keep serving
    expect((await page(dupToken)).item).toMatchObject({ title: "פריט למיזוג" });
  });

  it("a privacy erasure leaves nothing of the entries", async () => {
    const item = await linkItem("פריט למחיקה");
    const leadId = await lead(member.id);
    const token = await create(member, item, "lead", leadId);
    await page(token);
    const [entry] = await entries(leadId);
    await asUser(owner.id, async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [leadId]);
      await q("delete from public.leads where id = $1", [leadId]);
      await q("select public.audit_erase_record($1, 'leads', $2)", [org, leadId]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where id = $1", [entry.id]))).toBe(0);
    const audit = await asAdmin(async (q) => (await q<{ changes: unknown }>("select changes from public.audit_log where entity_type = 'activities' and entity_id = $1", [entry.id])).rows);
    // any log line of the entry is emptied, and no log line anywhere still carries it
    for (const row of audit) expect(row.changes).toEqual({ erased: true });
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and changes::text like '%' || $2 || '%'", [org, entry.id]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.library_links where lead_id = $1", [leadId]))).toBe(0);
  });
});
