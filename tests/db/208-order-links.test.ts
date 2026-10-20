import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Answer = Record<string, unknown> & {
  order: Record<string, unknown>;
  customer: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  schedule: Array<Record<string, unknown>>;
  decision: { decision: string; decided_at: string } | null;
  fingerprint: string | null;
  status_page?: Record<string, unknown>;
  rate_limited?: boolean;
};
type Decide = { status: string };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * ORD-05 (owner, 20 October 2026): a numbered order gets a secret link (only its SHA-256 is kept), made, seen and turned off
 * by whoever may edit the order. public.order_public(token, ip_hash) (service_role only) answers only what the customer's
 * page shows, by the one rule for sent links: not found only for an unknown or revoked token, a deleted customer, a business
 * without the flag or with its public pages closed; a cancelled order shows its state only. Views are limited per link and
 * per sender (keyed IP hash). public.order_public_decide records one answer on a new order (as QUO-09) and tells its owner;
 * the answer is read by owners and admins only and emptied by a privacy erasure.
 */
describe("the customer's link to an order (ORD-05)", () => {
  let owner: U, admin: U, member: U, other: U, outsider: U;
  let org: string, otherOrg: string;

  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setFeatures = (orgId: string, features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [orgId, JSON.stringify(features)]));
  const newOrder = (u: U, orgId: string, name: string, confirm = true) =>
    run(u, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [orgId, name, u.id])).id;
      const order = (
        await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id, notes, shipping_address) values ($1, $2, 'הערה ללקוח', 'רחוב הלקוח 3') returning id", [
          orgId,
          contact,
        ])
      ).id;
      await q("insert into public.order_lines (organization_id, order_id, name, description, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 'תיאור', 2, 10000)", [orgId, order]);
      await q("insert into public.order_payment_steps (organization_id, order_id, position, name, percent_bp, milestone) values ($1, $2, 0, 'מקדמה', 3000, 'באישור'), ($1, $2, 1, 'יתרה', 7000, 'באספקה')", [
        orgId,
        order,
      ]);
      if (confirm) await q("select public.order_confirm($1, $2)", [orgId, order]);
      return { contact, order };
    });
  const create = (u: U, orgId: string, order: string) => run(u, async (q) => (await one<{ t: string }>(q, "select public.order_link_create($1, $2) as t", [orgId, order])).t);
  const revoke = (u: U, orgId: string, order: string) => run(u, async (q) => (await one<{ r: boolean }>(q, "select public.order_link_revoke($1, $2) as r", [orgId, order])).r);
  const status = (u: U, orgId: string, order: string) =>
    run(u, async (q) => (await one<{ s: { active: boolean; created_at: string | null } }>(q, "select public.order_link_status($1, $2) as s", [orgId, order])).s);
  const page = (token: string, ip: string | null = null) => asService(async (q) => (await one<{ p: Answer }>(q, "select public.order_public($1, $2) as p", [token, ip])).p);
  const notFound = async (token: string) => expect((await pgError(page(token))).code).toBe("P0002");
  const decide = (token: string, args: Record<string, unknown>) =>
    asService(async (q) =>
      (
        await one<{ r: Decide }>(
          q,
          `select public.order_public_decide(p_token => $1, p_decision => $2, p_fingerprint => $3, p_signer_name => $4, p_id_number => $5,
                   p_signature_kind => $6, p_signature_image => $7, p_wording_version => $8, p_agreed => $9, p_decline_reason => $10,
                   p_ip => $11, p_user_agent => $12) as r`,
          [
            token,
            args.decision,
            args.fingerprint,
            args.name ?? null,
            args.id ?? null,
            args.kind ?? null,
            args.image ?? null,
            args.wording ?? null,
            args.agreed ?? false,
            args.reason ?? null,
            args.ip ?? "203.0.113.5",
            args.ua ?? "Mozilla/5.0 test",
          ],
        )
      ).r,
    );
  const approve = (token: string, fingerprint: string | null, name = "דנה כהן") =>
    decide(token, { decision: "accepted", fingerprint, name, kind: "typed", wording: "order-draft-2026-10-20", agreed: true });

  beforeAll(async () => {
    owner = await createUser("ol-owner");
    org = await createOrg(owner.id, "עסק ההזמנות");
    admin = await addMember(org, owner.id, "admin", "ol-admin");
    member = await addMember(org, owner.id, "member", "ol-member");
    other = await addMember(org, owner.id, "member", "ol-other");
    outsider = await createUser("ol-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await setFeatures(org, { orders: true });
    await setFeatures(otherOrg, { orders: true });
    for (const [u, o] of [
      [owner, org],
      [outsider, otherOrg],
    ] as const) {
      await run(u, (q) =>
        q(
          `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat, phone) values ($1, 'licensed', false, '03-5550000')
           on conflict (organization_id) do update set vat_status = 'licensed', prices_include_vat = false`,
          [o],
        ),
      );
    }
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
  });

  it("only whoever may edit a numbered order makes, sees and turns off its link; only the hash is kept", async () => {
    const draft = await newOrder(member, org, "טיוטה", false);
    expect((await pgError(create(member, org, draft.order))).hint).toBe("order_link:draft");
    const { order } = await newOrder(member, org, "דנה");
    // another member (visibility own), an outsider and the service role (no person) may not
    for (const u of [other, outsider]) expect((await pgError(create(u, org, order))).code, u.email).toBe("42501");
    expect((await pgError(asService((q) => q("select public.order_link_create($1, $2)", [org, order])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.order_link_create($1, $2)", [org, order])))).code).toBe("42501");

    const token = await create(member, org, order);
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const stored = await asAdmin((q) => one<{ token_hash: string }>(q, "select token_hash from app.order_links where order_id = $1", [order]));
    expect(stored.token_hash).toBe(sha256(token));
    const audit = await asAdmin(async (q) => (await q<{ changes: unknown }>("select changes from public.audit_log where entity_id = $1 and action = 'order_link'", [order])).rows);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(stored.token_hash);
    expect(await status(member, org, order)).toMatchObject({ active: true });
    expect(await status(owner, org, order)).toMatchObject({ active: true });
    expect((await pgError(status(other, org, order))).code).toBe("42501");

    // a new link replaces the old one
    const second = await create(owner, org, order);
    await notFound(token);
    expect((await page(second)).order.number).not.toBeNull();
    expect(await revoke(member, org, order)).toBe(true);
    await notFound(second);
    expect(await status(member, org, order)).toMatchObject({ active: false, created_at: null });
    // nobody but the service role reads the page, and nobody reads the links table
    expect((await pgError(run(owner, (q) => q("select public.order_public($1)", [second])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.order_public($1)", [second])))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select * from app.order_links")))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("select * from app.order_links")))).code).toBe("42501");
  });

  it("the page holds only what the confirmation shows: no ids, products, price sources or live records", async () => {
    const { order, contact } = await newOrder(member, org, "רון");
    const token = await create(member, org, order);
    const p = await page(token);
    expect(Object.keys(p).sort()).toEqual(["brand", "built_with", "business", "customer", "decision", "design", "fingerprint", "lines", "order", "schedule"]);
    expect(Object.keys(p.order).sort()).toEqual(
      [
        "currency",
        "delivery_date",
        "discount_agorot",
        "discount_bp",
        "discount_total_agorot",
        "net_total_agorot",
        "no_vat_note",
        "no_vat_reason",
        "notes",
        "number",
        "order_date",
        "prices_include_vat",
        "shipping_address",
        "status",
        "subtotal_agorot",
        "total_agorot",
        "vat_agorot",
        "vat_rate_bp",
      ].sort(),
    );
    expect(Object.keys(p.customer)).toEqual(["name"]);
    expect(p.lines).toHaveLength(1);
    expect(Object.keys(p.lines[0]).sort()).toEqual(
      ["billing", "description", "discount_agorot", "discount_bp", "kind", "name", "position", "quantity", "total_agorot", "unit_name", "unit_price_agorot", "vat_exempt"].sort(),
    );
    // ORD-04: the schedule with each step's share of the total (23,600: 30% and 70%)
    expect(p.schedule.map((s) => s.amount_agorot)).toEqual([7080, 16520]);
    expect(p.order).toMatchObject({ status: "new", notes: "הערה ללקוח", shipping_address: "רחוב הלקוח 3", total_agorot: 23600 });
    expect(p.decision).toBeNull();
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(p);
    expect(text).not.toMatch(UUID);
    for (const id of [org, order, contact, member.id]) expect(text).not.toContain(id);
  });

  it("the one rule: a cancelled order shows its state only; other states show the order without a decision", async () => {
    const cancelled = await newOrder(member, org, "מבוטלת");
    const token = await create(member, org, cancelled.order);
    await run(member, (q) => q("update public.orders set status = 'cancelled' where id = $1", [cancelled.order]));
    const p = await page(token);
    expect(Object.keys(p)).toEqual(["status_page"]);
    expect(p.status_page).toMatchObject({ state: "cancelled", business: "עסק ההזמנות", phone: "03-5550000" });
    expect(Object.keys(p.status_page!).sort()).toEqual(["business", "color", "logo", "number", "phone", "state"]);
    expect(JSON.stringify(p)).not.toMatch(UUID);
    // no new link for a cancelled order
    expect((await pgError(create(member, org, cancelled.order))).hint).toBe("order_link:cancelled");

    const moving = await newOrder(member, org, "בטיפול");
    const t2 = await create(member, org, moving.order);
    const fingerprint = (await page(t2)).fingerprint;
    await run(member, (q) => q("update public.orders set status = 'in_progress' where id = $1", [moving.order]));
    const p2 = await page(t2);
    expect(p2.order.status).toBe("in_progress");
    expect(p2.fingerprint).toBeNull();
    expect((await approve(t2, fingerprint)).status).toBe("closed");
  });

  it("not found for an unknown token, a deleted customer, a business without orders or with its public pages closed", async () => {
    await notFound("x".repeat(64));
    await notFound("short");
    const { order, contact } = await newOrder(member, org, "תמר");
    const token = await create(member, org, order);
    await setFeatures(org, { orders: false });
    await notFound(token);
    await setFeatures(org, { orders: true });
    expect((await page(token)).order).toBeDefined();
    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org]));
    await notFound(token);
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    expect((await page(token)).order).toBeDefined();
    // the customer purged: the order is detached and its link answers not found
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    expect(await run(owner, async (q) => (await q("delete from public.contacts where id = $1", [contact])).rowCount)).toBe(1);
    await notFound(token);
  });

  it("views are limited per link and per sender (keyed IP hash, scoped to the order); no hash is stored", async () => {
    const { order } = await newOrder(member, org, "יעל");
    const token = await create(member, org, order);
    const hash = "a".repeat(64);
    for (let i = 0; i < 60; i++) expect((await page(token, hash)).rate_limited, `view ${i + 1}`).toBeUndefined();
    expect((await page(token, hash)).rate_limited).toBe(true);
    // another sender still sees it
    expect((await page(token, "b".repeat(64))).order).toBeDefined();
    const stored = await asAdmin(async (q) => JSON.stringify((await q("select * from app.order_link_view_counts where order_id = $1", [order])).rows));
    expect(stored).not.toContain(hash);
    // the link's own window
    await asAdmin((q) => q("update app.order_links set window_started_at = now(), window_count = 120 where order_id = $1", [order]));
    expect((await page(token, "c".repeat(64))).rate_limited).toBe(true);
  });

  it("a new order takes one answer bound to what was shown; the owner is told; the order's status is left as it is", async () => {
    const { order } = await newOrder(member, org, "שירה");
    const token = await create(member, org, order);
    const fingerprint = (await page(token)).fingerprint!;
    // invalid: no agreement, a bad ID
    expect((await decide(token, { decision: "accepted", fingerprint, name: "שירה", kind: "typed", wording: "order-draft-2026-10-20", agreed: false })).status).toBe("invalid");
    expect((await decide(token, { decision: "accepted", fingerprint, name: "שירה", id: "123456789", kind: "typed", wording: "order-draft-2026-10-20", agreed: true })).status).toBe(
      "invalid",
    );
    // the delivery details changed in between: not decided
    await run(member, (q) => q("update public.orders set notes = 'הערה חדשה' where id = $1", [order]));
    expect((await approve(token, fingerprint)).status).toBe("changed");
    const fresh = (await page(token)).fingerprint!;
    expect((await approve(token, fresh, "שירה לוי")).status).toBe("accepted");
    expect((await approve(token, fresh)).status).toBe("already_decided");
    expect((await decide(token, { decision: "rejected", fingerprint: fresh })).status).toBe("already_decided");

    const row = await asAdmin((q) => one<Record<string, unknown>>(q, "select decision, signer_name, signature_kind, wording_version, content_sha256, ip, user_agent from public.order_decisions where order_id = $1", [order]));
    expect(row).toEqual({ decision: "accepted", signer_name: "שירה לוי", signature_kind: "typed", wording_version: "order-draft-2026-10-20", content_sha256: fresh, ip: "203.0.113.5", user_agent: "Mozilla/5.0 test" });
    expect((await asAdmin((q) => one<{ status: string }>(q, "select status from public.orders where id = $1", [order]))).status).toBe("new");
    // the page shows the answer (what and when only) and offers no other
    const after = await page(token);
    expect(after.decision).toMatchObject({ decision: "accepted" });
    expect(Object.keys(after.decision!).sort()).toEqual(["decided_at", "decision"]);
    expect(after.fingerprint).toBeNull();
    // the order's owner (the member who made it) is told, the number only
    const notice = await asAdmin((q) => one<{ user_id: string; type: string; title: string; body: string; entity_type: string }>(q, "select user_id, type, title, body, entity_type from public.notifications where entity_id = $1", [order]));
    expect(notice).toMatchObject({ user_id: member.id, type: "system", title: "הלקוח אישר את ההזמנה בקישור", entity_type: "order" });
    expect(notice.body).toMatch(/^הזמנה /);
    // the evidence is read by owners and admins only
    for (const u of [owner, admin]) expect(await run(u, (q) => count(q, "select 1 from public.order_decisions where order_id = $1", [order])), u.email).toBe(1);
    for (const u of [member, other]) expect(await run(u, (q) => count(q, "select 1 from public.order_decisions where order_id = $1", [order])), u.email).toBe(0);
    // only the service role decides
    expect((await pgError(run(owner, (q) => q("select public.order_public_decide($1, 'rejected', $2)", [token, fresh])))).code).toBe("42501");

    // a refusal, on another order
    const second = await newOrder(member, org, "אבי");
    const t2 = await create(member, org, second.order);
    const f2 = (await page(t2)).fingerprint!;
    expect((await decide(t2, { decision: "rejected", fingerprint: f2, reason: "המחיר גבוה" })).status).toBe("rejected");
    expect(await asAdmin((q) => one(q, "select decision, decline_reason, signature_kind from public.order_decisions where order_id = $1", [second.order]))).toEqual({
      decision: "rejected",
      decline_reason: "המחיר גבוה",
      signature_kind: null,
    });
  });

  it("tries to decide are limited per link", async () => {
    const { order } = await newOrder(member, org, "גל");
    const token = await create(member, org, order);
    for (let i = 0; i < 10; i++) expect((await approve(token, "0".repeat(64))).status).toBe("changed");
    expect((await approve(token, "0".repeat(64))).status).toBe("rate_limited");
  });

  it("nothing crosses businesses: one business's token shows only its order; its people manage only their own links", async () => {
    const mine = await newOrder(member, org, "שלנו");
    const theirs = await newOrder(outsider, otherOrg, "שלהם");
    const t1 = await create(member, org, mine.order);
    const t2 = await create(outsider, otherOrg, theirs.order);
    expect((await page(t1)).business).toMatchObject({ name: "עסק ההזמנות" });
    expect((await page(t2)).business).toMatchObject({ name: "עסק אחר" });
    // the other business's order through this business's id, and the reverse
    expect((await pgError(create(outsider, org, mine.order))).code).toBe("42501");
    expect((await pgError(create(member, otherOrg, theirs.order))).code).toBe("42501");
    expect((await pgError(create(member, org, theirs.order))).code).toBe("42501");
    expect((await pgError(revoke(outsider, org, mine.order))).code).toBe("42501");
    expect((await pgError(status(outsider, org, mine.order))).code).toBe("42501");
    // the other business's people never read this business's answers
    const f = (await page(t1)).fingerprint!;
    await approve(t1, f);
    expect(await run(outsider, (q) => count(q, "select 1 from public.order_decisions where order_id = $1", [mine.order]))).toBe(0);
  });

  it("a privacy erasure empties the signer's details on a detached order and keeps what, when and the fingerprint", async () => {
    const { order, contact } = await newOrder(member, org, "אורית");
    const token = await create(member, org, order);
    const f = (await page(token)).fingerprint!;
    expect((await approve(token, f, "אורית לוי")).status).toBe("accepted");
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    expect(await run(owner, async (q) => (await q("delete from public.contacts where id = $1", [contact])).rowCount)).toBe(1);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    const row = await asAdmin((q) =>
      one<Record<string, unknown>>(q, "select decision, signer_name, signer_id_number, signature_image, ip, user_agent, decline_reason, content_sha256, erased_at is not null as erased from public.order_decisions where order_id = $1", [order]),
    );
    expect(row).toEqual({ decision: "accepted", signer_name: null, signer_id_number: null, signature_image: null, ip: null, user_agent: null, decline_reason: null, content_sha256: f, erased: true });
  });
});
