import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, defaultLeadStatus, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Page = {
  business: string;
  brand: { logo: string | null; color: string | null };
  built_with: boolean;
  item: { kind: string; title: string; description: string | null; url: string | null; external_blocked?: boolean; file: { name: string; mime_type: string; size_bytes: number } | null };
  rate_limited?: boolean;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
// a keyed IP hash as the server sends it (64 hex)
const sender = (n: number) => sha256(`sender-${n}`);

/**
 * LIB-02: a library item sent by a personal tracked link. Staff who write in the business make a link for a record they read,
 * of an item that may be sent now; only the token's SHA-256 is kept. The page (public.library_link_public, service_role only)
 * answers only the business's display name, logo and colour and the item's public fields, counts the view (first, last,
 * count) and tells the maker once a business day. Anything else is "not found".
 */
describe("library items sent by a tracked link (LIB-02)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, other: U, outsider: U;
  let org: string, otherOrg: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const lead = async (ownerId: string, orgId = org) => {
    const status = await defaultLeadStatus(orgId);
    return asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.leads (organization_id, status_id, full_name, owner_id, phone, email) values ($1, $2, 'דנה כהן', $3, '050-7654321', 'dana@example.com') returning id", [orgId, status, ownerId])).id,
    );
  };
  const linkItem = (title = "קטלוג", orgId = org, u = owner) =>
    asUser(u.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.library_items (organization_id, kind, title, description, url) values ($1, 'link', $2, 'הקטלוג המלא', 'https://example.com/catalog') returning id", [orgId, title])).id,
    );
  const create = (u: U, item: string, type: string, id: string, orgId = org) =>
    asUser(u.id, async (q) => (await one<{ t: string }>(q, "select public.library_link_create($1, $2, $3, $4) as t", [orgId, item, type, id])).t);
  const page = (token: string, ip: string | null = sender(++n)) =>
    asService(async (q) => (await one<{ r: Page }>(q, "select public.library_link_public($1, $2) as r", [token, ip])).r);
  const linkOf = (token: string) =>
    asAdmin(async (q) =>
      one<{ id: string; view_count: number; first_viewed_at: string | null; last_viewed_at: string | null; created_by: string; lead_id: string | null; contact_id: string | null }>(
        q,
        "select l.* from public.library_links l join app.library_link_secrets s on s.link_id = l.id where s.token_hash = $1",
        [sha256(token)],
      ),
    );
  const notices = (u: U) =>
    asAdmin(async (q) => (await q<{ title: string; body: string | null; entity_type: string; entity_id: string }>("select title, body, entity_type, entity_id from public.notifications where user_id = $1 and type = 'library_viewed' order by created_at", [u.id])).rows);

  beforeAll(async () => {
    owner = await createUser("ll-owner");
    org = await createOrg(owner.id, "עסק הקישורים");
    admin = await addMember(org, owner.id, "admin", "ll-admin");
    manager = await addMember(org, owner.id, "manager", "ll-manager");
    member = await addMember(org, owner.id, "member", "ll-member");
    other = await addMember(org, owner.id, "member", "ll-other");
    viewer = await addMember(org, owner.id, "viewer", "ll-viewer");
    outsider = await createUser("ll-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asAdmin((q) => q("update public.organizations set brand_color = '#336699' where id = $1", [org]));
  });

  it("a writer makes a link for a record they read; only the token's hash is kept; viewers, outsiders and the API cannot", async () => {
    const item = await linkItem();
    const leadId = await lead(member.id);
    const token = await create(member, item, "lead", leadId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const stored = await asAdmin(async (q) => (await q<Record<string, unknown>>("select * from app.library_link_secrets where token_hash = $1", [sha256(token)])).rows);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);
    const row = await linkOf(token);
    expect(row.created_by).toBe(member.id);
    expect(row.lead_id).toBe(leadId);
    expect(row.view_count).toBe(0);
    // audited on the record, never with the token
    const audit = await asAdmin(async (q) => (await q<{ changes: unknown }>("select changes from public.audit_log where action = 'library_link' and entity_id = $1", [leadId])).rows);
    expect(audit).toEqual([{ changes: { link: "created", item } }]);

    expect((await pgError(create(viewer, item, "lead", leadId))).code).toBe("42501");
    expect((await pgError(create(outsider, item, "lead", leadId))).code).toBe("42501");
    // another business's item or record
    const foreignItem = await linkItem("של אחר", otherOrg, outsider);
    expect((await pgError(create(member, foreignItem, "lead", leadId))).hint).toBe("library_link:item");
    const foreignLead = await lead(outsider.id, otherOrg);
    expect((await pgError(create(member, item, "lead", foreignLead))).code).toBe("42501");
    expect((await pgError(create(outsider, item, "lead", leadId, otherOrg))).code).toBe("42501");
    // no client writes on the table; the page's functions are for the server only
    for (const sql of [
      "insert into public.library_links (organization_id, library_item_id, lead_id) values ($1, $2, $3)",
    ]) {
      expect((await pgError(asUser(owner.id, (q) => q(sql, [org, item, leadId])))).code).toBe("42501");
    }
    expect((await pgError(asUser(owner.id, (q) => q("update public.library_links set view_count = 9 where organization_id = $1", [org])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.library_links where organization_id = $1", [org])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select public.library_link_public($1, null)", [token])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.library_link_public($1, null)", [token])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select public.library_link_public_file($1, null)", [token])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.library_link_create($1, $2, 'lead', $3)", [org, item, leadId])))).code).toBe("42501");
  });

  it("a member cannot send to a record they do not read (visibility 'own')", async () => {
    const item = await linkItem();
    const others = await lead(other.id);
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect((await pgError(create(member, item, "lead", others))).code).toBe("42501");
      await create(manager, item, "lead", others).catch(() => null);
      expect(await create(admin, item, "lead", others)).toMatch(/^[A-Za-z0-9_-]{64}$/);
      // the member reads none of its links either
      expect(await asUser(member.id, (q) => count(q, "select 1 from public.library_links where lead_id = $1", [others]))).toBe(0);
      expect(await asUser(other.id, (q) => count(q, "select 1 from public.library_links where lead_id = $1", [others]))).toBeGreaterThan(0);
      expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.library_links where organization_id = $1", [org]))).toBe(0);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("the page answers only the business's display fields and the item's public fields, and counts the view", async () => {
    const item = await linkItem("מחירון 2027");
    const leadId = await lead(member.id);
    const token = await create(member, item, "lead", leadId);
    const answer = await page(token);
    expect(answer).toEqual({
      business: "עסק הקישורים",
      brand: { logo: null, color: "#336699" },
      built_with: expect.any(Boolean),
      item: { kind: "link", title: "מחירון 2027", description: "הקטלוג המלא", url: "https://example.com/catalog", external_blocked: false, file: null },
    });
    const text = JSON.stringify(answer);
    // no ids, no token, nothing of the record
    expect(text).not.toMatch(UUID);
    expect(text).not.toContain(token);
    for (const secret of ["דנה", "050", "dana@", leadId, org, item]) expect(text).not.toContain(secret);
    const row = await linkOf(token);
    expect(row.view_count).toBe(1);
    expect(row.first_viewed_at).not.toBeNull();
    await page(token);
    const again = await linkOf(token);
    expect(again.view_count).toBe(2);
    expect(again.first_viewed_at).toEqual(row.first_viewed_at);
  });

  it("tells the maker on the first opening only, with the item's title and the record's type only (owner (292) ב)", async () => {
    const item = await linkItem("מצגת החברה");
    const leadId = await lead(other.id);
    const token = await create(other, item, "lead", leadId);
    const before = (await notices(other)).length;
    await page(token);
    await page(token);
    await page(token);
    const after = await notices(other);
    expect(after.length - before).toBe(1);
    const notice = after[after.length - 1];
    expect(notice).toEqual({ title: "הלקוח פתח את הקישור ששלחת מהספרייה", body: "מצגת החברה", entity_type: "lead", entity_id: leadId });
    // the next business day is written on the timeline only, never told again
    await asAdmin((q) => q("update app.library_link_secrets set notified_on = notified_on - 1 where token_hash = $1", [sha256(token)]));
    await page(token);
    expect((await notices(other)).length - before).toBe(1);
    // owner (296) ג: a maker who left the business is not told; the owners and admins are, and the link keeps serving
    const leaver = await addMember(org, owner.id, "member", "ll-leaver");
    const lead2 = await lead(leaver.id);
    const t2 = await create(leaver, item, "lead", lead2);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, leaver.id]));
    const ownerBefore = (await notices(owner)).length;
    const adminBefore = (await notices(admin)).length;
    expect((await page(t2)).item.title).toBe("מצגת החברה");
    expect(await notices(leaver)).toHaveLength(0);
    expect((await notices(owner)).length - ownerBefore).toBe(1);
    expect((await notices(admin)).length - adminBefore).toBe(1);
  });

  it("anything else answers not found: unknown, turned off, item off or out of its window, record in the bin, closed pages", async () => {
    const notFound = async (token: string) => expect((await pgError(page(token))).code).toBe("P0002");
    await notFound("x".repeat(64));
    await notFound("short");
    const item = await linkItem("פריט שייסגר");
    const leadId = await lead(member.id);
    const token = await create(member, item, "lead", leadId);
    await page(token);

    await asUser(owner.id, (q) => q("update public.library_items set is_active = false where id = $1", [item]));
    await notFound(token);
    await asUser(owner.id, (q) => q("update public.library_items set is_active = true, valid_until = current_date - 2 where id = $1", [item]));
    await notFound(token);
    expect((await pgError(create(member, item, "lead", leadId))).hint).toBe("library_link:item");
    await asUser(owner.id, (q) => q("update public.library_items set valid_until = null, valid_from = current_date + 3 where id = $1", [item]));
    await notFound(token);
    await asUser(owner.id, (q) => q("update public.library_items set valid_from = null where id = $1", [item]));
    await page(token);

    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [leadId]));
    await notFound(token);
    expect((await pgError(create(admin, item, "lead", leadId))).hint).toBe("library_link:record");
    await asAdmin((q) => q("update public.leads set deleted_at = null where id = $1", [leadId]));
    await page(token);

    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org]));
    try {
      await notFound(token);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    await page(token);

    // the maker turns it off (another member cannot; an admin can); the page then answers not found
    const linkId = (await linkOf(token)).id;
    expect((await pgError(asUser(other.id, (q) => q("select public.library_link_revoke($1, $2)", [org, linkId])))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("select public.library_link_revoke($1, $2)", [org, linkId])))).code).toBe("42501");
    expect(await asUser(member.id, async (q) => (await one<{ r: boolean }>(q, "select public.library_link_revoke($1, $2) as r", [org, linkId])).r)).toBe(true);
    await notFound(token);
    expect(await asUser(admin.id, async (q) => (await one<{ r: boolean }>(q, "select public.library_link_revoke($1, $2) as r", [org, linkId])).r)).toBe(false);
    const row = await asAdmin(async (q) => one<{ revoked_by: string; token_hash: string | null }>(q, "select l.revoked_by, s.token_hash from public.library_links l join app.library_link_secrets s on s.link_id = l.id where l.id = $1", [linkId]));
    expect(row).toEqual({ revoked_by: member.id, token_hash: null });
  });

  it("a read-only business takes no new links but its pages still open", async () => {
    const item = await linkItem("פריט בעסק לקריאה בלבד");
    const leadId = await lead(member.id);
    const token = await create(member, item, "lead", leadId);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      const refused = await pgError(create(owner, item, "lead", leadId));
      expect(refused.code).toBe("P0001");
      expect(refused.hint).toBe("org:read_only");
      // an outsider still gets the plain refusal, never the business's state
      expect((await pgError(create(outsider, item, "lead", leadId))).code).toBe("42501");
      expect((await page(token)).item.title).toBe("פריט בעסק לקריאה בלבד");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("limits 120 calls per link and 60 per sender in 10 minutes, after the lookup; no hash is kept", async () => {
    const item = await linkItem("פריט מוגבל");
    const leadId = await lead(member.id);
    const token = await create(member, item, "lead", leadId);
    const ip = sender(9000);
    for (let i = 0; i < 60; i += 1) expect((await page(token, ip)).rate_limited).toBeUndefined();
    expect(await page(token, ip)).toEqual({ rate_limited: true });
    // another sender still gets in until the link's 120
    expect((await page(token, sender(9001))).item.title).toBe("פריט מוגבל");
    const counts = await asAdmin(async (q) => (await q<Record<string, unknown>>("select * from app.library_link_view_counts")).rows);
    expect(JSON.stringify(counts)).not.toContain(ip);
    for (let i = 0; i < 70; i += 1) await page(token, null);
    expect(await page(token, null)).toEqual({ rate_limited: true });
    // a limited call is not a view
    expect((await linkOf(token)).view_count).toBeLessThanOrEqual(120);
  });

  it("a file item's link serves only its current confirmed file; a link item has no file", async () => {
    const item = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.library_items (organization_id, kind, title) values ($1, 'file', 'קטלוג PDF') returning id", [org])).id);
    const contactId = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'רון') returning id", [org])).id);
    // no current file: cannot be sent
    expect((await pgError(create(member, item, "contact", contactId))).hint).toBe("library_link:item");
    const file = await asUser(owner.id, async (q) =>
      one<{ id: string; storage_path: string }>(q, "insert into public.files (organization_id, library_item_id, name, mime_type, size_bytes) values ($1, $2, 'catalog.pdf', 'application/pdf', 1000) returning id, storage_path", [org, item]),
    );
    await asUser(owner.id, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [file.storage_path]));
    await asAdmin((q) => q("update storage.objects set metadata = jsonb_build_object('size', 1000::bigint, 'mimetype', 'application/pdf') where bucket_id = 'record-files' and name = $1", [file.storage_path]));
    expect(await asUser(owner.id, async (q) => (await one<{ r: { ok: boolean } }>(q, "select public.confirm_file_upload($1, $2) as r", [org, file.id])).r)).toEqual({ ok: true });

    const token = await create(member, item, "contact", contactId);
    const answer = await page(token);
    expect(answer.item).toEqual({ kind: "file", title: "קטלוג PDF", description: null, url: null, external_blocked: false, file: { name: "catalog.pdf", mime_type: "application/pdf", size_bytes: 1000 } });
    const served = await asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.library_link_public_file($1, $2) as r", [token, sender(5000)])).r);
    expect(served).toEqual({ path: file.storage_path, name: "catalog.pdf", mime_type: "application/pdf" });
    // a download is not a view
    expect((await linkOf(token)).view_count).toBe(1);
    // a waiting replacement is not served
    await asUser(owner.id, (q) => q("insert into public.files (organization_id, library_item_id, name, mime_type, size_bytes) values ($1, $2, 'new.pdf', 'application/pdf', 10)", [org, item]));
    expect(((await asService(async (q) => (await one<{ r: { name: string } }>(q, "select public.library_link_public_file($1, null) as r", [token])).r))).name).toBe("catalog.pdf");

    const linkOnly = await linkItem("קישור בלבד");
    const t2 = await create(member, linkOnly, "contact", contactId);
    expect((await pgError(asService((q) => q("select public.library_link_public_file($1, null)", [t2])))).code).toBe("P0002");
  });

  it("works for a deal and a company; the links follow a merged duplicate; a purge takes them", async () => {
    const item = await linkItem("פריט לעסקה");
    const { pipelineId, stageId } = await asAdmin(async (q) => {
      const p = await one<{ id: string }>(q, "select id from public.pipelines where organization_id = $1 and is_default", [org]);
      const s = await one<{ id: string }>(q, "select id from public.stages where pipeline_id = $1 order by position limit 1", [p.id]);
      return { pipelineId: p.id, stageId: s.id };
    });
    const dealId = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [org, pipelineId, stageId])).id);
    const companyId = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה') returning id", [org])).id);
    expect(await create(member, item, "deal", dealId)).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(await create(member, item, "company", companyId)).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect((await pgError(create(member, item, "task", dealId))).code).toBe("22023");

    // merge: the duplicate's link moves to the kept lead
    const kept = await lead(owner.id);
    const dup = await lead(owner.id);
    const token = await create(member, item, "lead", dup);
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}'::jsonb)", [org, kept, dup]));
    expect((await linkOf(token)).lead_id).toBe(kept);
    expect((await page(token)).item.title).toBe("פריט לעסקה");

    // deleting the item takes its links
    await asUser(owner.id, (q) => q("delete from public.library_items where id = $1", [item]));
    expect(await asAdmin((q) => count(q, "select 1 from public.library_links where library_item_id = $1", [item]))).toBe(0);
    expect((await pgError(page(token))).code).toBe("P0002");
  });

  it("caps a maker at 100 links an hour in a business", async () => {
    const item = await linkItem("פריט רב");
    const leadId = await lead(manager.id);
    await asAdmin((q) =>
      q(
        "insert into public.library_links (organization_id, library_item_id, lead_id, created_by) select $1, $2, $3, $4 from generate_series(1, 100)",
        [org, item, leadId, manager.id],
      ),
    );
    expect((await pgError(create(manager, item, "lead", leadId))).hint).toBe("library_link:rate");
    expect(await create(owner, item, "lead", leadId)).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });
});
