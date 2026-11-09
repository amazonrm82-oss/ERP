import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Answer = { ok: boolean; reason?: string; order_id?: string | null };

/**
 * CAL-13 (owner 9 November 2026, answers (152) א and (153) ג): a held meeting makes a draft order with one line of the meeting
 * type's product, automatically while the business chose 'auto', else by the button; once per meeting; never when a punch card
 * covered the meeting, the type has no offerable product, the meeting has no live contact, or the plan lacks orders/products.
 */
describe("draft order from a held meeting (CAL-13)", () => {
  let owner: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let typeA: string, typeB: string, typeNoProduct: string;
  let service: string, card: string;
  const FEATURES = { orders: true, products: true, price_lists: true, payments: true, punch_cards: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));
  const setMode = (mode: "auto" | "button") =>
    run(owner, (q) => q("update public.org_document_settings set meeting_order_draft = $2 where organization_id = $1", [org, mode]));
  const contact = (u: U, name: string) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, u.id])).id);
  const meeting = (u: U, contactId: string | null, type: string | null, status = "held", extra: { owner?: string; deal?: string } = {}) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id, meeting_type_id, status, owner_id, deal_id)
           values ($1, 'טיפול', now() - interval '2 hours', now() - interval '1 hour', $2, $3, $4, coalesce($5, auth.uid()), $6) returning id`,
          [org, contactId, type, status, extra.owner ?? null, extra.deal ?? null],
        )
      ).id,
    );
  const setStatus = (u: U, id: string, status: string) => run(u, (q) => q("update public.meetings set status = $2 where id = $1", [id, status]));
  const press = (u: U, meetingId: string, orgId = org) =>
    run(u, async (q) => (await one<{ r: Answer }>(q, "select public.meeting_order_draft_create($1, $2) as r", [orgId, meetingId])).r);
  const states = (u: U, ids: string[], orgId = org) =>
    run(u, async (q) => (await one<{ r: Record<string, { reason: string | null; order_id: string | null }> }>(q, "select public.meeting_order_draft_states($1, $2) as r", [orgId, ids])).r);
  const draftOf = (meetingId: string) =>
    asAdmin(async (q) => (await q<{ order_id: string }>("select order_id from app.meeting_order_drafts where meeting_id = $1", [meetingId])).rows[0]?.order_id ?? null);
  const order = (id: string) =>
    asAdmin((q) =>
      one<{ status: string; source: string; contact_id: string; deal_id: string | null; owner_id: string | null; created_by: string | null; total_agorot: string; net_total_agorot: string }>(
        q,
        "select status, source, contact_id, deal_id, owner_id, created_by, total_agorot::text, net_total_agorot::text from public.orders where id = $1",
        [id],
      ),
    );
  const lines = (orderId: string) =>
    asAdmin(async (q) =>
      (
        await q<{ product_id: string; name: string; quantity: string; unit_price_agorot: string; price_source: string; price_list_name: string | null; vat_exempt: boolean; billing: string }>(
          "select product_id, name, quantity::text, unit_price_agorot::text, price_source, price_list_name, vat_exempt, billing from public.order_lines where order_id = $1",
          [orderId],
        )
      ).rows,
    );

  beforeAll(async () => {
    owner = await createUser("cal13-owner");
    org = await createOrg(owner.id, "קליניקה");
    member = await addMember(org, owner.id, "member", "cal13-member");
    other = await addMember(org, owner.id, "member", "cal13-other");
    viewer = await addMember(org, owner.id, "viewer", "cal13-viewer");
    outsider = await createUser("cal13-outsider");
    otherOrg = await createOrg(outsider.id, "עסק זר");
    await setFeatures(FEATURES);
    await run(owner, (q) => q("insert into public.org_modules (organization_id, orders_enabled) values ($1, true)", [org]));
    await run(owner, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)", [org]),
    );
    service = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.products (organization_id, name, kind, price_agorot, billing) values ($1, 'טיפול פיזיותרפיה', 'service', 30000, 'one_time') returning id", [org])).id,
    );
    const types = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.meeting_types where organization_id = $1 order by position, created_at, id", [org])).rows.map((r) => r.id),
    );
    [typeA, typeB, typeNoProduct] = types;
    await run(owner, (q) => q("update public.meeting_types set product_id = $2 where id = any($1)", [[typeA, typeB], service]));
    card = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.products (organization_id, name, kind, price_agorot, punch_entries, punch_meeting_type_ids)
           values ($1, 'כרטיסייה', 'punch_card', 100000, 5, $2) returning id`,
          [org, [typeB]],
        )
      ).id,
    );
  });

  it("defaults to the button; the setting takes button|auto and only owners/admins write it", async () => {
    const mode = await run(member, async (q) => (await one<{ m: string }>(q, "select meeting_order_draft as m from public.org_document_settings where organization_id = $1", [org])).m);
    expect(mode).toBe("button");
    expect((await pgError(run(owner, (q) => q("update public.org_document_settings set meeting_order_draft = 'always' where organization_id = $1", [org])))).code).toBe("23514");
    const changed = await run(member, async (q) => (await q("update public.org_document_settings set meeting_order_draft = 'auto' where organization_id = $1 returning id", [org])).rowCount);
    expect(changed).toBe(0);
  });

  it("button mode: holding the meeting makes nothing; the button makes one draft order, once", async () => {
    const c = await contact(member, "נועה");
    const m = await meeting(member, c, typeA);
    expect(await draftOf(m)).toBeNull();
    expect((await states(member, [m]))[m]).toEqual({ reason: null, order_id: null });
    const answer = await press(member, m);
    expect(answer.ok).toBe(true);
    const id = answer.order_id as string;
    expect(await order(id)).toMatchObject({ status: "draft", source: "manual", contact_id: c, deal_id: null, owner_id: member.id, created_by: member.id });
    // one line of the service: its name, quantity 1, the product's price, VAT 17-18% added on the order
    const [line] = await lines(id);
    expect(line).toMatchObject({ product_id: service, name: "טיפול פיזיותרפיה", quantity: "1", unit_price_agorot: "30000", price_source: "product", vat_exempt: false, billing: "one_time" });
    expect(Number((await order(id)).net_total_agorot)).toBe(30000);
    expect(Number((await order(id)).total_agorot)).toBeGreaterThan(30000);
    // a second press, and another status round trip, make nothing more
    expect(await press(member, m)).toEqual({ ok: false, reason: "exists", order_id: id });
    // owner (169) א: a numbered order made from the draft still blocks (only deleting the draft frees the meeting)
    const m9 = await meeting(member, await contact(member, "נועה ב"), typeA);
    const numbered = (await press(member, m9)).order_id as string;
    await run(member, (q) => q("select public.order_confirm($1, $2)", [org, numbered]));
    expect((await order(numbered)).status).toBe("new");
    expect(await press(member, m9)).toEqual({ ok: false, reason: "exists", order_id: numbered });
    expect((await states(member, [m9]))[m9]).toEqual({ reason: "exists", order_id: numbered });
    await setStatus(member, m, "planned");
    await setStatus(member, m, "held");
    expect(await asAdmin((q) => count(q, "select 1 from public.orders where contact_id = $1", [c]))).toBe(1);
    // leaving 'held' keeps the draft (lead's choice)
    await setStatus(member, m, "cancelled");
    expect(await draftOf(m)).toBe(id);
    expect((await states(member, [m]))[m]).toEqual({ reason: "exists", order_id: id });
    // deleting the draft frees the meeting
    await setStatus(member, m, "held");
    await run(member, (q) => q("delete from public.orders where id = $1", [id]));
    expect(await draftOf(m)).toBeNull();
    expect((await press(member, m)).ok).toBe(true);
  });

  it("automatic mode: a meeting marked held gets its draft once; inserted as held too", async () => {
    await setMode("auto");
    try {
      const c = await contact(member, "יואב");
      const m = await meeting(member, c, typeA, "planned");
      expect(await draftOf(m)).toBeNull();
      await setStatus(member, m, "held");
      const id = await draftOf(m);
      expect(id).not.toBeNull();
      // the server made it: the organizer owns it
      expect(await order(id as string)).toMatchObject({ status: "draft", contact_id: c, owner_id: member.id });
      await setStatus(member, m, "planned");
      await setStatus(member, m, "held");
      expect(await asAdmin((q) => count(q, "select 1 from public.orders where contact_id = $1", [c]))).toBe(1);
      const m2 = await meeting(member, c, typeA, "held");
      expect(await draftOf(m2)).not.toBeNull();
      // the button after the automatic draft answers exists
      expect((await press(member, m2)).reason).toBe("exists");
    } finally {
      await setMode("button");
    }
  });

  it("automatic mode: a failure while making the draft never fails the meeting's write, and the session is put back", async () => {
    const c = await contact(member, "גל");
    await setMode("auto");
    try {
      const ROLLBACK = new Error("rollback the arranged failure");
      const seen = await asAdmin(async (q) => {
        // arranged in one transaction that is rolled back: an order insert that always fails
        await q("create function public.cal13_fail() returns trigger language plpgsql as $f$ begin raise exception 'boom'; end; $f$");
        await q("create trigger cal13_fail before insert on public.orders for each row execute function public.cal13_fail()");
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: member.id, role: "authenticated" })]);
        await q("set local role authenticated");
        const row = (
          await q<{ id: string }>(
            `insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id, meeting_type_id, status)
             values ($1, 'טיפול', now() - interval '2 hours', now() - interval '1 hour', $2, $3, 'held') returning id`,
            [org, c, typeA],
          )
        ).rows[0];
        const who = (await q<{ uid: string }>("select auth.uid()::text as uid")).rows[0].uid;
        await q("reset role");
        const drafts = Number((await q<{ n: string }>("select count(*) as n from app.meeting_order_drafts where meeting_id = $1", [row.id])).rows[0].n);
        throw Object.assign(ROLLBACK, { result: { id: row.id, who, drafts } });
      }).catch((error: Error & { result?: { id: string; who: string; drafts: number } }) => {
        if (error !== ROLLBACK) throw error;
        return error.result!;
      });
      expect(seen.id).toBeTruthy();
      expect(seen.who).toBe(member.id);
      expect(seen.drafts).toBe(0);
    } finally {
      await setMode("button");
    }
  });

  it("a meeting a punch card covered gets no draft, by either path", async () => {
    const c = await contact(owner, "מיכל");
    await run(owner, (q) => q("select public.punch_card_open($1, $2, $3, null, true)", [org, c, card]));
    // activated a day earlier, so a meeting just before midnight in the business zone still counts on it
    await asAdmin((q) => q("update public.punch_cards set activated_at = now() - interval '1 day' where contact_id = $1", [c]));
    await setMode("auto");
    try {
      const m = await meeting(owner, c, typeB);
      expect(await asAdmin((q) => count(q, "select 1 from public.punch_card_uses where meeting_id = $1 and returned_at is null", [m]))).toBe(1);
      expect(await draftOf(m)).toBeNull();
      expect(await press(owner, m)).toMatchObject({ ok: false, reason: "punch_card" });
      // the same contact's meeting of a type the card does not cover gets one
      const m2 = await meeting(owner, c, typeA);
      expect(await draftOf(m2)).not.toBeNull();
    } finally {
      await setMode("button");
    }
  });

  it("no product, an archived product, no type, no contact, a binned contact, a planned meeting: no draft and a reason", async () => {
    const c = await contact(member, "שירה");
    const noProduct = await meeting(member, c, typeNoProduct);
    const noType = await meeting(member, c, null);
    const noContact = await meeting(member, null, typeA);
    const planned = await meeting(member, c, typeA, "planned");
    const gone = await contact(member, "נמחק");
    const goneMeeting = await meeting(member, gone, typeA);
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [gone]));
    expect(await press(member, noProduct)).toMatchObject({ ok: false, reason: "no_product" });
    expect(await press(member, noType)).toMatchObject({ ok: false, reason: "no_type" });
    expect(await press(member, noContact)).toMatchObject({ ok: false, reason: "no_contact" });
    expect(await press(member, planned)).toMatchObject({ ok: false, reason: "not_held" });
    expect(await press(owner, goneMeeting)).toMatchObject({ ok: false, reason: "contact_gone" });
    const st = await states(member, [noProduct, noType, noContact, planned]);
    expect([st[noProduct].reason, st[noType].reason, st[noContact].reason]).toEqual(["no_product", "no_type", "no_contact"]);
    // a meeting that is neither held nor has a draft gets no entry
    expect(st[planned]).toBeUndefined();

    const archived = await meeting(member, c, typeA);
    await run(owner, (q) => q("update public.products set archived_at = now() where id = $1", [service]));
    try {
      expect(await press(member, archived)).toMatchObject({ ok: false, reason: "product_unavailable" });
      await setMode("auto");
      // in automatic mode a refusal makes nothing and never fails the meeting's write
      const m = await meeting(member, c, typeA);
      expect(await draftOf(m)).toBeNull();
    } finally {
      await setMode("button");
      await asAdmin((q) => q("update public.products set archived_at = null where id = $1", [service]));
    }
  });

  it("needs the orders and products keys and the orders module", async () => {
    const c = await contact(member, "רון");
    const m = await meeting(member, c, typeA);
    try {
      await setFeatures({ ...FEATURES, orders: false });
      expect((await press(member, m)).reason).toBe("feature_orders");
      await setFeatures({ ...FEATURES, products: false });
      expect((await press(member, m)).reason).toBe("feature_products");
      await setFeatures(FEATURES);
      await run(owner, (q) => q("update public.org_modules set orders_enabled = false where organization_id = $1", [org]));
      expect((await press(member, m)).reason).toBe("module_off");
      await setMode("auto");
      const m2 = await meeting(member, c, typeA);
      expect(await draftOf(m2)).toBeNull();
    } finally {
      await setMode("button");
      await setFeatures(FEATURES);
      await run(owner, (q) => q("update public.org_modules set orders_enabled = true where organization_id = $1", [org]));
    }
    expect((await press(member, m)).ok).toBe(true);
  });

  it("rights: a member who may not edit the contact, a viewer and an outsider cannot press; the automatic path still works", async () => {
    // org visibility (the default): "other" reads the member's contact but may not edit it
    try {
      const c = await contact(member, "תמר");
      const m = await meeting(member, c, typeA);
      expect((await states(other, [m]))[m].reason).toBe("not_permitted");
      expect(await press(other, m)).toMatchObject({ ok: false, reason: "not_permitted" });
      expect(await press(viewer, m)).toMatchObject({ ok: false, reason: "not_permitted" });
      // an outsider learns nothing: same answer for a real meeting in another business and for nothing
      expect(await press(outsider, m)).toEqual({ ok: false, reason: "not_found" });
      expect(await press(outsider, m, otherOrg)).toMatchObject({ ok: false, reason: "not_found" });
      expect(await states(outsider, [m])).toEqual({});
      expect(await states(outsider, [m], otherOrg)).toEqual({});
      expect(await draftOf(m)).toBeNull();
      // owner (171) ב: in automatic mode "other", who may not edit the contact, marks a meeting held: no draft, one notice
      await setMode("auto");
      const notices = (meetingId: string) =>
        asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'system' and entity_type = 'meeting' and entity_id = $2", [other.id, meetingId]));
      const m2 = await meeting(other, c, typeA, "planned");
      await setStatus(other, m2, "held");
      expect(await draftOf(m2)).toBeNull();
      expect(await notices(m2)).toBe(1);
      const notice = await asAdmin(async (q) =>
        one<{ title: string; body: string }>(q, "select title, body from public.notifications where user_id = $1 and entity_id = $2", [other.id, m2]),
      );
      expect(notice).toEqual({ title: "לא נוצרה טיוטת הזמנה מהפגישה", body: "אין לך הרשאה על הלקוח של הפגישה. מי שיש לו הרשאה יכול ליצור אותה מהפגישה." });
      // once per meeting
      await setStatus(other, m2, "planned");
      await setStatus(other, m2, "held");
      expect(await notices(m2)).toBe(1);
      // the member who may edit makes it with the button
      const id = (await press(member, m2)).order_id as string;
      expect(id).toBeTruthy();
      // no notice when nothing could be made anyway (no product)
      const m6 = await meeting(other, c, typeNoProduct, "held");
      expect(await notices(m6)).toBe(0);
      // a write with no session (an import, an automation, a booking) makes the draft as the server
      const serverMeeting = await asAdmin(async (q) =>
        (
          await one<{ id: string }>(
            q,
            `insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id, meeting_type_id, status, owner_id)
             values ($1, 'טיפול', now() - interval '2 hours', now() - interval '1 hour', $2, $3, 'held', $4) returning id`,
            [org, c, typeA, member.id],
          )
        ).id,
      );
      expect(await draftOf(serverMeeting)).not.toBeNull();
      // "other" may not edit the contact: not_permitted comes first, by the button and on the card; the card still links the
      // order for someone who reads it (org visibility), the button never names it
      expect((await states(other, [m2]))[m2]).toEqual({ reason: "not_permitted", order_id: id });
      expect(await press(other, m2)).toEqual({ ok: false, reason: "not_permitted" });
      // the member who may edit hears "exists" with the order
      expect(await press(member, m2)).toEqual({ ok: false, reason: "exists", order_id: id });
      // with "own" visibility the order's id is not given to someone who does not read the contact
      await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
      expect((await states(other, [m2]))[m2]).toEqual({ reason: "not_permitted", order_id: null });
      // a meeting the caller may not see: not_found by the button, no entry on the card
      const hidden = await meeting(member, c, typeA);
      expect(await press(other, hidden)).toEqual({ ok: false, reason: "not_found" });
      expect(await states(other, [hidden])).toEqual({});
    } finally {
      await setMode("button");
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("owner = the organizer while usable, else none; the deal is attached only when it is the same contact's", async () => {
    const c = await contact(owner, "אורי");
    const { pipelineId, stages } = await defaultPipeline(org);
    const pipeline = { pipeline_id: pipelineId, stage_id: stages.find((s) => s.kind === "open")!.id };
    const deal = (contactId: string) =>
      run(owner, async (q) =>
        (
          await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [
            org,
            pipeline.pipeline_id,
            pipeline.stage_id,
            contactId,
            owner.id,
          ])
        ).id,
      );
    const same = await deal(c);
    const elsewhere = await deal(await contact(owner, "אחר"));
    // an organizer who was suspended is not usable
    const leaver = await addMember(org, owner.id, "member", "cal13-leaver");
    const m1 = await meeting(owner, c, typeA, "held", { deal: same, owner: leaver.id });
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, leaver.id]));
    const m2 = await meeting(owner, c, typeA, "held", { deal: elsewhere });
    const o1 = (await press(owner, m1)).order_id as string;
    const o2 = (await press(owner, m2)).order_id as string;
    // no usable organizer: no owner (the server's write leaves it empty)
    expect(await order(o1)).toMatchObject({ deal_id: same, owner_id: null, created_by: owner.id });
    expect(await order(o2)).toMatchObject({ deal_id: null, owner_id: owner.id });

    // an organizer who does not read the order's parent is not kept as its owner
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const m3 = await meeting(owner, c, typeA, "held", { owner: other.id });
      const m4 = await meeting(owner, c, typeA, "held", { owner: other.id, deal: same });
      expect(await order((await press(owner, m3)).order_id as string)).toMatchObject({ deal_id: null, owner_id: null, created_by: owner.id });
      expect(await order((await press(owner, m4)).order_id as string)).toMatchObject({ deal_id: same, owner_id: null });
      // with org visibility the same organizer reads the contact and owns the draft
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
      const m5 = await meeting(owner, c, typeA, "held", { owner: other.id });
      expect(await order((await press(owner, m5)).order_id as string)).toMatchObject({ owner_id: other.id });
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("the button keeps the presser's session: the order's and the line's audit entries name them; the server setting is put back", async () => {
    const c = await contact(member, "עדי");
    const m = await meeting(member, c, typeA);
    const after = await run(member, async (q) => {
      const answer = (await one<{ r: Answer }>(q, "select public.meeting_order_draft_create($1, $2) as r", [org, m])).r;
      const settings = await one<{ server: string | null; no_owner: string | null; uid: string }>(
        q,
        "select current_setting('app.order_server', true) as server, current_setting('app.meeting_order_no_owner', true) as no_owner, auth.uid()::text as uid",
      );
      return { answer, settings };
    });
    expect(after.answer.ok).toBe(true);
    expect(after.settings.uid).toBe(member.id);
    expect(after.settings.server ?? "").toBe("");
    expect(after.settings.no_owner ?? "").toBe("");
    const id = after.answer.order_id as string;
    const actors = await asAdmin(async (q) =>
      (
        await q<{ entity_type: string; actor_id: string | null }>(
          `select entity_type, actor_id from public.audit_log
            where organization_id = $1 and action = 'insert'
              and (entity_id = $2 or entity_id in (select l.id from public.order_lines l where l.order_id = $2))
            order by entity_type`,
          [org, id],
        )
      ).rows,
    );
    expect(actors).toEqual([
      { entity_type: "order_lines", actor_id: member.id },
      { entity_type: "orders", actor_id: member.id },
    ]);
  });

  it("orders_check_meeting_owner empties an owner only inside a definer, never for a person who sets the setting", async () => {
    // what backs the guard in production: a person cannot choose an order's id, so cannot name it in the setting in advance
    const granted = await asAdmin(async (q) =>
      (await one<{ ok: boolean }>(q, "select has_column_privilege('authenticated', 'public.orders', 'id', 'INSERT') as ok")).ok,
    );
    expect(granted).toBe(false);
    // the guard itself: inside ONE transaction that is rolled back, the id grant is given to authenticated for a moment, so
    // a person CAN insert an order whose id the setting names; the trigger still keeps their owner because current_user is
    // 'authenticated'. The control in the same transaction: the same insert as the table owner (current_user is not
    // 'authenticated', as inside the make function) with the setting naming that id gets an empty owner.
    const c = await contact(member, "שומר");
    const ROLLBACK = new Error("rollback the temporary grant");
    const seen = await asAdmin(async (q) => {
      await q("grant insert (id) on public.orders to authenticated");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: member.id, role: "authenticated" })]);
      const asPerson = "00000000-0000-4000-8000-0000000000a1";
      const asServer = "00000000-0000-4000-8000-0000000000a2";
      await q("set local role authenticated");
      await q("select set_config('app.meeting_order_no_owner', $1, true)", [asPerson]);
      const person = (await q<{ owner_id: string | null }>("insert into public.orders (id, organization_id, contact_id) values ($1, $2, $3) returning owner_id", [asPerson, org, c])).rows[0].owner_id;
      await q("reset role");
      await q("select set_config('app.meeting_order_no_owner', $1, true)", [asServer]);
      const server = (await q<{ owner_id: string | null }>("insert into public.orders (id, organization_id, contact_id) values ($1, $2, $3) returning owner_id", [asServer, org, c])).rows[0].owner_id;
      throw Object.assign(ROLLBACK, { result: { person, server } });
    }).catch((error: Error & { result?: { person: string | null; server: string | null } }) => {
      if (error !== ROLLBACK) throw error;
      return error.result!;
    });
    expect(seen).toEqual({ person: member.id, server: null });
    expect(await asAdmin((q) => count(q, "select 1 from public.orders where contact_id = $1", [c]))).toBe(0);
  });

  it("app.meeting_order_draft_meeting_readable is the meetings_select rule (keep in step)", async () => {
    const c = await contact(member, "השוואה");
    const lead = await addMember(org, owner.id, "manager", "cal13-team-lead");
    const rep = await addMember(org, owner.id, "member", "cal13-rep");
    const guest = await addMember(org, owner.id, "member", "cal13-guest");
    // the team-manager branch: "lead" manages the team of "rep"
    await asAdmin(async (q) => {
      const team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות טיפולים') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false)", [org, team, lead.id, rep.id]);
    });
    // internal meetings (no record), each reached by one branch only
    const internal = (organizer: U) => meeting(owner, null, null, "planned", { owner: organizer.id });
    const byManager = await internal(rep);
    const byCreator = await internal(rep);
    // created by someone else than its organizer: touch_row keeps created_by for every writer, so the arranged value is set
    // with the row triggers off for this one statement
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.meetings set created_by = $2 where id = $1", [byCreator, guest.id]);
    });
    const byParticipant = await internal(rep);
    await asAdmin((q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, byParticipant, viewer.id]));
    const ids = [
      await meeting(member, c, typeA),
      await meeting(owner, c, typeA, "held", { owner: other.id }),
      await meeting(owner, null, null),
      byManager,
      byCreator,
      byParticipant,
    ];
    try {
      for (const visibility of ["own", "org"]) {
        await asAdmin((q) => q("update public.organizations set record_visibility = $2 where id = $1", [org, visibility]));
        // each branch is really hit (the comparison below would pass vacuously otherwise)
        if (visibility === "own") {
          const sees = (u: U, id: string) => run(u, (q) => count(q, "select 1 from public.meetings where id = $1", [id]));
          expect([await sees(lead, byManager), await sees(guest, byCreator), await sees(viewer, byParticipant)]).toEqual([1, 1, 1]);
          // and nobody else through them
          expect([await sees(guest, byManager), await sees(viewer, byCreator), await sees(guest, byParticipant)]).toEqual([0, 0, 0]);
        }
        for (const u of [owner, member, other, viewer, outsider, lead, rep, guest]) {
          const byPolicy = await run(u, async (q) => (await q<{ id: string }>("select id from public.meetings where id = any($1) order by id", [ids])).rows.map((r) => r.id));
          const byHelper = await asAdmin(async (q) => {
            await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u.id, role: "authenticated" })]);
            return (
              await q<{ id: string }>("select m.id from public.meetings m where m.id = any($1) and app.meeting_order_draft_meeting_readable(m) order by m.id", [ids])
            ).rows.map((r) => r.id);
          });
          expect(byHelper, `${visibility} ${u.email}`).toEqual(byPolicy);
        }
      }
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("prices by the customer's price list (PL-03), like other order lines", async () => {
    const list = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.price_lists (organization_id, name) values ($1, 'מחירון חברים') returning id", [org])).id,
    );
    await run(owner, (q) => q("insert into public.price_list_lines (organization_id, price_list_id, product_id, min_quantity, discount_bp) values ($1, $2, $3, 0, 1000)", [org, list, service]));
    const c = await contact(owner, "חבר מועדון");
    await run(owner, (q) => q("update public.contacts set price_list_id = $2 where id = $1", [c, list]));
    const m = await meeting(owner, c, typeA);
    const id = (await press(owner, m)).order_id as string;
    expect((await lines(id))[0]).toMatchObject({ unit_price_agorot: "27000", price_source: "price_list", price_list_name: "מחירון חברים" });
  });

  it("a fixed-price tier with its own VAT flag, and a business whose prices include VAT", async () => {
    const rate = await asAdmin(async (q) => (await one<{ r: number }>(q, "select app.document_vat_rate(current_date) as r")).r);
    const withVat = (price: number) => Math.floor((price * (10000 + rate) * 2 + 10000) / 20000);
    const withoutVat = (price: number) => Math.floor((price * 10000 * 2 + (10000 + rate)) / (2 * (10000 + rate)));
    // a list whose prices include VAT (its lines take the flag from it) in a business whose prices do not
    const list = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.price_lists (organization_id, name, prices_include_vat) values ($1, 'מחירון כולל', true) returning id", [org])).id,
    );
    await run(owner, (q) => q("insert into public.price_list_lines (organization_id, price_list_id, product_id, min_quantity, price_agorot) values ($1, $2, $3, 0, 23600)", [org, list, service]));
    const c = await contact(owner, "מחיר קבוע");
    await run(owner, (q) => q("update public.contacts set price_list_id = $2 where id = $1", [c, list]));
    const fixed = (await press(owner, await meeting(owner, c, typeA))).order_id as string;
    expect((await lines(fixed))[0]).toMatchObject({ unit_price_agorot: String(withoutVat(23600)), price_source: "price_list", price_list_name: "מחירון כולל" });

    // the business types prices with VAT: the product's price before VAT is carried into the order's mode
    await run(owner, (q) => q("update public.org_document_settings set prices_include_vat = true where organization_id = $1", [org]));
    try {
      const plain = await contact(owner, "כולל מעמ");
      const id = (await press(owner, await meeting(owner, plain, typeA))).order_id as string;
      expect((await lines(id))[0]).toMatchObject({ unit_price_agorot: String(withVat(30000)), price_source: "product" });
      const row = await asAdmin(async (q) => one<{ prices_include_vat: boolean; total: string }>(q, "select prices_include_vat, total_agorot::text as total from public.orders where id = $1", [id]));
      expect(row).toEqual({ prices_include_vat: true, total: String(withVat(30000)) });
      // the fixed tier with VAT now goes in as typed
      const again = (await press(owner, await meeting(owner, c, typeA))).order_id as string;
      expect((await lines(again))[0]).toMatchObject({ unit_price_agorot: "23600" });
    } finally {
      await run(owner, (q) => q("update public.org_document_settings set prices_include_vat = false where organization_id = $1", [org]));
    }
  });

  it("tenant isolation: the link table is closed to clients; another business's meeting answers not found", async () => {
    expect((await pgError(run(owner, (q) => q("select * from app.meeting_order_drafts")))).code).toBe("42501");
    const foreignContact = await run(outsider, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'זר', $2) returning id", [otherOrg, outsider.id])).id,
    );
    const foreign = await run(outsider, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id, status) values ($1, 'זר', now() - interval '2 hours', now() - interval '1 hour', $2, 'held') returning id",
          [otherOrg, foreignContact],
        )
      ).id,
    );
    expect(await press(owner, foreign)).toEqual({ ok: false, reason: "not_found" });
    expect(await press(owner, foreign, otherOrg)).toEqual({ ok: false, reason: "not_found" });
    expect(await states(owner, [foreign])).toEqual({});
    expect((await pgError(run(owner, (q) => q("select public.meeting_order_draft_states($1, $2)", [org, Array.from({ length: 201 }, () => foreign)])))).hint).toBe(
      "meeting_order_draft:too_many",
    );
    // anon cannot call either function
    expect(
      await asAdmin(async (q) =>
        count(q, "select 1 from information_schema.routine_privileges where routine_name like 'meeting_order_draft%' and grantee in ('anon', 'PUBLIC')"),
      ),
    ).toBe(0);
  });
});
