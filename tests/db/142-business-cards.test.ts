import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Card = Record<string, unknown>;

/**
 * BIZ-02: a rep's digital business card, a public secret-link page (owner, 13 October 2026): only fields marked public,
 * an inactive or deleted rep is "not found", the form goes through intake_submit and the lead goes to the rep, rate
 * limits, nothing beyond the page and no cross-organization access.
 */
describe("business cards (BIZ-02)", () => {
  let owner: U, admin: U, member: U, member2: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let card: { id: string; token: string };
  let hashSeq = 0;
  const hash = () => `hash-${process.pid}-${++hashSeq}`.padStart(64, "0");

  const makeCard = (who: U, user: U, fields: Record<string, unknown> = {}, o: string = org) =>
    asUser(who.id, async (q) => {
      const row: Record<string, unknown> = { organization_id: o, user_id: user.id, ...fields };
      const cols = Object.keys(row);
      return (
        await q<{ id: string; token: string }>(
          `insert into public.business_cards (${cols.join(", ")}) values (${cols.map((c, i) => (c === "public_fields" ? `$${i + 1}::text[]` : `$${i + 1}`)).join(", ")}) returning id, token`,
          Object.values(row),
        )
      ).rows[0];
    });
  // A sender whose view bucket on this card holds no views yet (the 1,024 buckets are shared by all senders, so a random
  // sender can land in a bucket an earlier test already counted in; the bucket rule is the database's own).
  const freshSender = async (cardId: string): Promise<string> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = hash();
      const used = await asAdmin(async (q) =>
        (
          await q<{ used: boolean }>(
            `select exists (select 1 from app.business_card_view_counts c
                             where c.card_id = $1
                               and c.bucket = ((hashtextextended(app.business_card_sender($1, $2), 0) % 1024) + 1024) % 1024) as used`,
            [cardId, candidate],
          )
        ).rows[0].used,
      );
      if (!used) return candidate;
    }
    throw new Error("no free view bucket found");
  };
  const view = (token: string, ipHash: string | null = hash()) =>
    asService(async (q) => (await q<{ r: Card }>("select public.business_card_public($1, $2) as r", [token, ipHash])).rows[0].r);
  const submit = (token: string, payload: Record<string, unknown>, ipHash: string | null = hash(), spam = false) =>
    asService(async (q) =>
      (await q<{ r: Card }>("select public.business_card_submit($1, $2, $3, 'test', $4) as r", [token, JSON.stringify(payload), ipHash, spam])).rows[0].r,
    );

  beforeAll(async () => {
    owner = await createUser("card-owner");
    org = await createOrg(owner.id, "עסק הכרטיסים");
    admin = await addMember(org, owner.id, "admin", "card-admin");
    member = await addMember(org, owner.id, "member", "card-member");
    member2 = await addMember(org, owner.id, "member", "card-member2");
    viewer = await addMember(org, owner.id, "viewer", "card-viewer");
    outsider = await createUser("card-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    card = await makeCard(member, member, {
      job_title: "יועצת מכירות",
      about: "עשר שנים בתחום",
      phone: "052-1234567",
      email: "rep@example.test",
      website: "https://example.test",
      public_fields: ["job_title", "phone", "whatsapp"],
    });
  });

  it("the rep and owners/admins manage a card; nobody else sees or writes it", async () => {
    const seen = (who: U) => asUser(who.id, (q) => count(q, "select 1 from public.business_cards where id = $1", [card.id]));
    expect(await seen(member)).toBe(1);
    expect(await seen(admin)).toBe(1);
    expect(await seen(owner)).toBe(1);
    expect(await seen(member2)).toBe(0);
    expect(await seen(viewer)).toBe(0);
    expect(await seen(outsider)).toBe(0);
    // a member never makes or changes a colleague's card
    expect((await pgError(makeCard(member2, member))).code).toBe("42501");
    for (const who of [member2, viewer, outsider]) {
      expect(await asUser(who.id, async (q) => (await q("update public.business_cards set job_title = 'נחטף'")).rowCount)).toBe(0);
      expect(await asUser(who.id, async (q) => (await q("delete from public.business_cards")).rowCount)).toBe(0);
    }
    expect(await asUser(admin.id, async (q) => (await q("update public.business_cards set about = 'עודכן' where id = $1", [card.id])).rowCount)).toBe(1);
    // the token, the rep and the business are fixed
    for (const set of ["token = 'x'", `user_id = '${member2.id}'`, `organization_id = '${otherOrg}'`]) {
      expect((await pgError(asUser(member.id, (q) => q(`update public.business_cards set ${set} where id = $1`, [card.id])))).code, set).toBe("42501");
    }
    // the shown fields come from the closed list
    expect((await pgError(asUser(member.id, (q) => q("update public.business_cards set public_fields = '{salary}' where id = $1", [card.id])))).code).toBe("23514");
    // an outsider gets the plain refusal
    expect((await pgError(makeCard(outsider, member))).code).toBe("42501");
  });

  it("one card per rep (the plan), the flag, and only for an active member who is not a viewer", async () => {
    expect((await pgError(makeCard(member, member))).hint).toBe("limit:max_business_cards_per_user");
    expect((await pgError(makeCard(admin, viewer))).hint).toBe("business_card:rep");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"business_card\": false}' where organization_id = $1", [org]));
    try {
      expect((await pgError(makeCard(member2, member2))).hint).toBe("feature:business_card");
      expect((await pgError(view(card.token))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{}' where organization_id = $1", [org]));
    }
    // a viewer has no card and makes none
    expect((await pgError(makeCard(viewer, viewer))).code).toBe("42501");
  });

  it("each card has its own form, made and changed only with the card, outside the web forms", async () => {
    const form = await asAdmin(async (q) =>
      (
        await q<{ id: string; token: string; kind: string; owner_id: string; assign_mode: string; source: string; source_kind: string }>(
          `select f.id, f.token, f.kind, f.owner_id, f.assign_mode, s.name as source, s.kind as source_kind
             from public.forms f join public.lead_sources s on s.organization_id = f.organization_id and s.id = f.source_id
            where f.business_card_id = $1`,
          [card.id],
        )
      ).rows[0],
    );
    expect(form).toMatchObject({ kind: "card", owner_id: member.id, assign_mode: "owner", source: "כרטיס ביקור", source_kind: "business_card" });
    // a person neither makes, changes nor deletes a card form
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.forms (organization_id, kind, name) values ($1, 'card', 'x')", [org])))).hint).toBe("form:card");
    expect((await pgError(asUser(owner.id, (q) => q("update public.forms set owner_id = $2 where id = $1", [form.id, owner.id])))).hint).toBe("form:card");
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.forms where id = $1", [form.id])))).hint).toBe("form:card");
    // it is not a web form: no hosted page, no web-form intake, no max_forms slot
    expect(await asService(async (q) => (await q<{ r: unknown }>("select public.intake_form($1) as r", [form.token])).rows[0].r)).toBeNull();
    expect((await pgError(asService((q) => q("select public.intake_submit($1, 'form', '{\"full_name\": \"x\"}'::jsonb)", [form.token])))).code).toBe("P0002");
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{\"max_forms\": 1}' where organization_id = $1", [org]));
    try {
      await asUser(owner.id, (q) => q("insert into public.forms (organization_id, kind, name) values ($1, 'form', 'טופס יחיד')", [org]));
    } finally {
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{}' where organization_id = $1", [org]));
    }
    // a second card in the business reuses the source
    const second = await makeCard(member2, member2);
    expect(await asAdmin((q) => count(q, "select 1 from public.lead_sources where organization_id = $1 and kind = 'business_card'", [org]))).toBe(1);
    // the card's removal takes its form with it; the inquiries stay
    const secondForm = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.forms where business_card_id = $1", [second.id])).rows[0].id);
    await submit(second.token, { full_name: "פנייה לכרטיס שיימחק", phone: "050-7777001" });
    expect(await asUser(member2.id, async (q) => (await q("delete from public.business_cards where id = $1", [second.id])).rowCount)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.forms where id = $1", [secondForm]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where form_id is null and organization_id = $1 and form_deleted_at is not null", [org]))).toBeGreaterThan(0);
  });

  it("the page answers only what the card shows, by token, to the server only", async () => {
    const page = await view(card.token);
    expect(page).toEqual({
      name: "card-member",
      business: "עסק הכרטיסים",
      brand: {},
      built_with: true,
      job_title: "יועצת מכירות",
      phone: "052-1234567",
      whatsapp: "972521234567",
      form: true,
    });
    // nothing it did not mark public, and no ids or tokens anywhere
    const text = JSON.stringify(page);
    for (const secret of [card.id, card.token, org, member.id, "rep@example.test", "example.test", "עודכן"]) {
      expect(text, secret).not.toContain(secret);
    }
    await asUser(member.id, (q) => q("update public.business_cards set public_fields = '{}' where id = $1", [card.id]));
    expect(Object.keys(await view(card.token)).sort()).toEqual(["brand", "built_with", "business", "form", "name"]);
    await asUser(member.id, (q) => q("update public.business_cards set public_fields = '{job_title,about,phone,email,whatsapp,website}' where id = $1", [card.id]));
    expect(await view(card.token)).toMatchObject({ about: "עודכן", email: "rep@example.test", website: "https://example.test" });
    await asUser(member.id, (q) => q("update public.business_cards set public_fields = '{job_title,phone,whatsapp}' where id = $1", [card.id]));
    // a wrong token, the browser roles: nothing
    expect((await pgError(view("0".repeat(32)))).code).toBe("P0002");
    expect((await pgError(asAnon((q) => q("select public.business_card_public($1)", [card.token]))))).toMatchObject({ code: "42501" });
    expect((await pgError(asUser(member.id, (q) => q("select public.business_card_public($1)", [card.token]))))).toMatchObject({ code: "42501" });
    expect((await pgError(asUser(member.id, (q) => q("select public.business_card_submit($1, '{}'::jsonb)", [card.token]))))).toMatchObject({ code: "42501" });
  });

  it("an inactive card, an inactive or viewer rep, and a closed business are not found at once", async () => {
    const notFound = async (label: string) => {
      expect((await pgError(view(card.token))).code, label).toBe("P0002");
      expect((await pgError(submit(card.token, { full_name: "x", phone: "050-1111111" }))).code, label).toBe("P0002");
    };
    await asUser(member.id, (q) => q("update public.business_cards set is_active = false where id = $1", [card.id]));
    await notFound("card off");
    await asUser(member.id, (q) => q("update public.business_cards set is_active = true where id = $1", [card.id]));
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, member.id]));
    await notFound("rep suspended");
    await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, member.id]));
    // a viewer's card (no person can make one; written here without the triggers) is not found either
    const viewerCard = await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      return (await q<{ token: string }>("insert into public.business_cards (organization_id, user_id) values ($1, $2) returning token", [org, viewer.id])).rows[0].token;
    });
    expect((await pgError(view(viewerCard))).code).toBe("P0002");
    expect((await pgError(submit(viewerCard, { full_name: "x", phone: "050-1111112" }))).code).toBe("P0002");
    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org]));
    await notFound("business cancelled");
    // a read-only business still shows the card and takes the form (like the web forms)
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await view(card.token)).toMatchObject({ form: true });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    expect(await view(card.token)).toMatchObject({ name: "card-member" });
  });

  it("the form makes a lead of the rep through intake_submit, and answers its status only", async () => {
    const reply = await submit(card.token, {
      full_name: "לקוח מהכרטיס",
      phone: "050-1234999",
      email: "client@example.test",
      message: "אשמח לשיחה",
      attribution: { utm_source: "card" },
      // not asked by the card: dropped
      custom: { anything: "x" },
      callback: "now",
      company_name: "לא נשאל",
    });
    expect(reply).toEqual({ status: "accepted" });
    const lead = await asAdmin(async (q) =>
      (
        await q<{ owner_id: string; source: string; full_name: string; company_name: string | null; message: string; utm: Record<string, unknown>; custom_fields: Record<string, unknown> }>(
          `select l.owner_id, s.name as source, l.full_name, l.company_name, l.message, l.utm, l.custom_fields
             from public.leads l join public.lead_sources s on s.organization_id = l.organization_id and s.id = l.source_id
            where l.organization_id = $1 and l.phone = '050-1234999'`,
          [org],
        )
      ).rows[0],
    );
    expect(lead).toMatchObject({ owner_id: member.id, source: "כרטיס ביקור", full_name: "לקוח מהכרטיס", company_name: null, message: "אשמח לשיחה" });
    expect(lead.utm).toMatchObject({ utm_source: "card" });
    expect(lead.custom_fields).toEqual({});
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where organization_id = $1 and lead_id = (select id from public.leads where phone = '050-1234999')", [org]))).toBe(0);
    // the same person again: one lead, the answer the same
    expect(await submit(card.token, { full_name: "לקוח מהכרטיס", phone: "050-1234999" })).toEqual({ status: "accepted" });
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and phone = '050-1234999'", [org]))).toBe(1);
    // spam is answered like the rest and keeps nothing as a lead
    expect(await submit(card.token, { full_name: "בוט", phone: "050-0000001" }, hash(), true)).toEqual({ status: "spam" });
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and phone = '050-0000001'", [org]))).toBe(0);
    // intake_submit's own checks
    expect((await pgError(submit(card.token, { message: "בלי פרטים" }))).code).toBe("22023");
    expect((await pgError(submit(card.token, { full_name: "x", email: "not-an-email" }))).code).toBe("22023");
    // nothing lands in another business
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [otherOrg]))).toBe(0);
  });

  it("rate limits: 60 views per sender in 10 minutes, and intake_submit's per sender", async () => {
    const sender = await freshSender(card.id);
    for (let i = 0; i < 60; i += 1) expect((await view(card.token, sender)).rate_limited).toBeUndefined();
    expect(await view(card.token, sender)).toEqual({ rate_limited: true });
    // another sender is not held back (one whose bucket is not the full one)
    expect((await view(card.token, await freshSender(card.id))).name).toBe("card-member");
    const poster = hash();
    for (let i = 0; i < 10; i += 1) await submit(card.token, { full_name: `שולח ${i}`, phone: `050-90000${10 + i}` }, poster);
    expect((await pgError(submit(card.token, { full_name: "האחד עשר", phone: "050-9000099" }, poster))).hint).toBe("rate_limited");
    // no IP hash kept for views
    expect(await asAdmin((q) => count(q, "select 1 from app.business_card_view_counts where card_id = $1", [card.id]))).toBeGreaterThan(0);
    const columns = await asAdmin(async (q) =>
      (await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'app' and table_name = 'business_card_view_counts'")).rows.map((r) => r.column_name).sort(),
    );
    expect(columns).toEqual(["bucket", "card_id", "views", "window_start"]);
  });

  it("one sender is a different sender on every card (the hash is scoped to the card)", async () => {
    const other = await makeCard(admin, member2, { phone: "054-2222222" });
    const sender = hash();
    await submit(card.token, { full_name: "שולח משותף", phone: "050-3333001" }, sender);
    await submit(other.token, { full_name: "שולח משותף", phone: "050-3333002" }, sender);
    const stored = await asAdmin(async (q) =>
      (
        await q<{ ip_hash: string; card: string }>(
          `select s.ip_hash, f.business_card_id as card from public.form_submissions s
             join public.forms f on f.organization_id = s.organization_id and f.id = s.form_id
            where s.organization_id = $1 and s.payload ->> 'phone' in ('050-3333001', '050-3333002')`,
          [org],
        )
      ).rows,
    );
    expect(stored).toHaveLength(2);
    const [a, b] = stored;
    expect(a.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.ip_hash).not.toBe(b.ip_hash);
    expect(stored.map((r) => r.ip_hash)).not.toContain(sender);
    // the same scoping the database applies: SHA-256 of the card and the server's hash
    const expected = await asAdmin(async (q) => (await q<{ h: string }>("select app.business_card_sender($1, $2) as h", [card.id, sender])).rows[0].h);
    expect(stored.find((r) => r.card === card.id)?.ip_hash).toBe(expected);
  });

  it("another business's card never reaches this one", async () => {
    const outsiderCard = await makeCard(outsider, outsider, { phone: "053-5555555" }, otherOrg);
    expect(await submit(outsiderCard.token, { full_name: "לקוח של אחר", phone: "053-1000001" })).toEqual({ status: "accepted" });
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and phone = '053-1000001'", [org]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and phone = '053-1000001' and owner_id = $2", [otherOrg, outsider.id]))).toBe(1);
    // a card cannot name a person of another business
    expect((await pgError(makeCard(owner, outsider))).hint).toBe("business_card:rep");
  });
});
