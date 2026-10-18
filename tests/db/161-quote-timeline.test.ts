import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Entry = { type: string; body: string; deal_id: string | null; contact_id: string | null; created_by: string | null; kind: string; quote_id: string; number: string | null };

/**
 * QUO-16, the timeline part (owner, 18 October 2026, answer 15): sending, accepting and declining a quote each leave one
 * entry on its deal and its contact (the deal alone without a contact; whichever is still there). "Sent" is the sender's
 * own action and counts as contact with the customer; "accepted" and "declined" are system entries. The text names the
 * number only (the screen adds the title), never an amount.
 */
describe("a quote's timeline entries (QUO-16)", () => {
  let owner: U, admin: U, member: U, viewer: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const contact = (name: string) =>
    asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, member.id])).id);
  const deal = (contactId: string | null) =>
    asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [
          org,
          pipelineId,
          stageId,
          contactId,
          member.id,
        ])
      ).id,
    );
  // a draft with one priced line, made by the member on a deal or a contact
  const draft = (parent: { deal?: string; contact?: string }, title = "שיפוץ מטבח לנועה") =>
    asUser(member.id, async (q) => {
      const id = (
        await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, $2, $3, $4) returning id", [
          org,
          title,
          parent.deal ?? null,
          parent.contact ?? null,
        ])
      ).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 1234567)", [org, id]);
      return id;
    });
  const send = (quote: string) => asUser(member.id, (q) => q("select public.quote_send($1, $2)", [org, quote]));
  const entries = (quote: string) =>
    asAdmin(async (q) =>
      (
        await q<Entry>(
          `select type, body, deal_id, contact_id, created_by, metadata->>'kind' as kind, metadata->>'quote_id' as quote_id, metadata->>'number' as number
             from public.activities where organization_id = $1 and metadata->>'quote_id' = $2 order by created_at, id`,
          [org, quote],
        )
      ).rows,
    );
  const lastContacted = (contactId: string) =>
    asAdmin(async (q) => (await one<{ t: Date | null }>(q, "select last_contacted_at as t from public.contacts where id = $1", [contactId])).t);

  beforeAll(async () => {
    owner = await createUser("qt-owner");
    org = await createOrg(owner.id, "עסק ההצעות");
    admin = await addMember(org, owner.id, "admin", "qt-admin");
    member = await addMember(org, owner.id, "member", "qt-member");
    viewer = await addMember(org, owner.id, "viewer", "qt-viewer");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("sending leaves the sender's own entry on the deal and the contact, which counts as contact with the customer", async () => {
    const person = await contact("נועה");
    const quote = await draft({ deal: await deal(person) });
    expect(await lastContacted(person)).toBeNull();
    const before = Date.now();
    await send(quote);
    const number = await asAdmin(async (q) => (await one<{ n: string }>(q, "select number_display as n from public.quotes where id = $1", [quote])).n);
    const [entry, ...rest] = await entries(quote);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ type: "note", created_by: member.id, contact_id: person, kind: "quote_sent", quote_id: quote, number });
    expect(entry.deal_id).not.toBeNull();
    expect(entry.body).toBe(`הצעת מחיר ${number} נשלחה`);
    // the contact rule stamped it, as for any note the person logged
    const stamped = await lastContacted(person);
    expect(stamped).not.toBeNull();
    expect(stamped!.getTime()).toBeGreaterThanOrEqual(before - 5000);
    // whoever reads the deal reads the entry
    expect(await asUser(viewer.id, (q) => count(q, "select 1 from public.activities where metadata->>'quote_id' = $1", [quote]))).toBe(1);
  });

  it("names the number only: no title and no amount in the stored text", async () => {
    const person = await contact("דנה");
    const quote = await draft({ contact: person }, "הצעה סודית לדנה");
    await send(quote);
    const totals = await asAdmin(async (q) =>
      one<{ total: string; net: string; vat: string }>(q, "select total_agorot::text as total, net_total_agorot::text as net, vat_agorot::text as vat from public.quotes where id = $1", [quote]),
    );
    const stored = await asAdmin(async (q) =>
      (await q<{ j: string }>("select to_jsonb(a)::text as j from public.activities a where a.metadata->>'quote_id' = $1", [quote])).rows.map((r) => r.j),
    );
    expect(stored).toHaveLength(1);
    for (const amount of [totals.total, totals.net, totals.vat, "1234567"]) expect(stored[0]).not.toContain(amount);
    expect(stored[0]).not.toContain("סודית");
  });

  it("a contact's quote goes on the contact; a deal's quote without a contact on the deal alone, stamping nothing", async () => {
    const person = await contact("רונית");
    const contactQuote = await draft({ contact: person });
    await send(contactQuote);
    expect((await entries(contactQuote)).map((e) => [e.deal_id, e.contact_id])).toEqual([[null, person]]);

    const lone = await deal(null);
    const dealQuote = await draft({ deal: lone });
    await send(dealQuote);
    expect((await entries(dealQuote)).map((e) => [e.deal_id, e.contact_id])).toEqual([[lone, null]]);
  });

  it("accepted and declined are system entries with no author, and are not contact with the customer", async () => {
    for (const [status, kind, verb] of [
      ["accepted", "quote_accepted", "אושרה"],
      ["rejected", "quote_rejected", "נדחתה"],
    ] as const) {
      const person = await contact(`לקוח ${status}`);
      const quote = await draft({ deal: await deal(person) });
      await send(quote);
      await asAdmin((q) => q("update public.contacts set last_contacted_at = null where id = $1", [person]));
      // nothing sets these statuses for people yet (QUO-09 will); the server path is what the trigger serves
      await asAdmin((q) => q("update public.quotes set status = $2 where id = $1", [quote, status]));
      const all = await entries(quote);
      expect(all.map((e) => e.kind)).toEqual(["quote_sent", kind]);
      const last = all[1];
      expect(last).toMatchObject({ type: "system", created_by: null, contact_id: person });
      expect(last.body.endsWith(verb)).toBe(true);
      expect(await lastContacted(person)).toBeNull();
    }
  });

  it("a status that does not change, a draft edit and another status add nothing; a quote with no deal or contact left adds nothing", async () => {
    const person = await contact("טל");
    const quote = await draft({ contact: person });
    await asUser(member.id, (q) => q("update public.quotes set title = 'כותרת חדשה' where id = $1", [quote]));
    expect(await entries(quote)).toEqual([]);
    await send(quote);
    await asAdmin((q) => q("update public.quotes set status = 'sent' where id = $1", [quote]));
    await asAdmin((q) => q("update public.quotes set status = 'viewed' where id = $1", [quote]));
    expect((await entries(quote)).map((e) => e.kind)).toEqual(["quote_sent"]);

    // the customer is purged: the sent quote is kept with no deal or contact, and a later decision is not written anywhere
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [person]));
    await asUser(owner.id, (q) => q("delete from public.contacts where id = $1", [person]));
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [quote]));
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where metadata->>'quote_id' = $1 and metadata->>'kind' = 'quote_accepted'", [quote]))).toBe(0);
  });

  // the sent entry of a fresh quote on the member's deal and contact
  const sentEntry = async () => {
    const person = await contact("היסטוריה");
    const dealId = await deal(person);
    const quote = await draft({ deal: dealId });
    await send(quote);
    const id = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.activities where metadata->>'quote_id' = $1", [quote])).id);
    return { person, dealId, quote, id };
  };
  const refused = async (p: Promise<unknown>) => {
    const err = await pgError(p);
    expect(err.code).toBe("42501");
    expect(err.hint).toBe("activity:quote_entry");
  };

  it("a person cannot write a quote entry: not as a new note, and not by turning a note into one", async () => {
    const person = await contact("זיוף");
    for (const kind of ["quote_sent", "quote_accepted", "quote_rejected", "quote_anything"]) {
      await refused(
        asUser(member.id, (q) =>
          q("insert into public.activities (organization_id, type, contact_id, body, metadata) values ($1, 'note', $2, 'הצעה נשלחה', jsonb_build_object('kind', $3::text))", [org, person, kind]),
        ),
      );
    }
    const note = await asUser(member.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.activities (organization_id, type, contact_id, body) values ($1, 'note', $2, 'הערה רגילה') returning id", [org, person])).id,
    );
    await refused(asUser(member.id, (q) => q("update public.activities set metadata = '{\"kind\": \"quote_sent\"}' where id = $1", [note])));
    await refused(asUser(owner.id, (q) => q("update public.activities set metadata = metadata || '{\"kind\": \"quote_accepted\"}' where id = $1", [note])));
    // an ordinary note is still the person's to edit and delete
    expect(await asUser(member.id, async (q) => (await q("update public.activities set body = 'הערה מתוקנת', metadata = '{\"x\": 1}' where id = $1", [note])).rowCount)).toBe(1);
    expect(await asUser(member.id, async (q) => (await q("delete from public.activities where id = $1", [note])).rowCount)).toBe(1);
  });

  it("nobody changes or deletes a quote entry: not its sender inside the edit window, not owners or admins", async () => {
    const { id } = await sentEntry();
    for (const u of [member, admin, owner]) {
      await refused(asUser(u.id, (q) => q("update public.activities set body = 'שונה' where id = $1", [id])));
      await refused(asUser(u.id, (q) => q("update public.activities set metadata = '{}' where id = $1", [id])));
      await refused(asUser(u.id, (q) => q("update public.activities set is_pinned = true where id = $1", [id])));
      await refused(asUser(u.id, (q) => q("update public.activities set is_private = true where id = $1", [id])));
      await refused(asUser(u.id, (q) => q("update public.activities set occurred_at = now() - interval '1 day' where id = $1", [id])));
      await refused(asUser(u.id, (q) => q("delete from public.activities where id = $1", [id])));
    }
    const kept = await asAdmin(async (q) => one<{ body: string; private: boolean; pinned: boolean }>(q, "select body, is_private as private, is_pinned as pinned from public.activities where id = $1", [id]));
    expect(kept.body.endsWith("נשלחה")).toBe(true);
    expect([kept.private, kept.pinned]).toEqual([false, false]);
  });

  it("server paths still move and remove the entries: a merge, a purge with its record, and a privacy erasure", async () => {
    // a merge moves the entry to the kept contact
    const { person, dealId, id } = await sentEntry();
    const keep = await contact("נשמר");
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, person]));
    expect(await asAdmin(async (q) => (await one<{ c: string }>(q, "select contact_id as c from public.activities where id = $1", [id])).c)).toBe(keep);

    // purging the contact keeps the entry on the deal; purging the deal removes it
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [keep]));
    expect(await asUser(owner.id, async (q) => (await q("delete from public.contacts where id = $1", [keep])).rowCount)).toBe(1);
    expect(await asAdmin(async (q) => one<{ c: string | null; d: string }>(q, "select contact_id as c, deal_id as d from public.activities where id = $1", [id]))).toEqual({ c: null, d: dealId });
    await asUser(owner.id, (q) => q("update public.deals set deleted_at = now() where id = $1", [dealId]));
    expect(await asUser(owner.id, async (q) => (await q("delete from public.deals where id = $1", [dealId])).rowCount)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where id = $1", [id]))).toBe(0);

    // a privacy erasure of the purged contact goes through
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, keep]));
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'erase' and entity_id = $2", [org, keep]))).toBe(1);
  });

  it("the guard's function is no one's to call either", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, 'app.activities_quote_entry_guard()', 'execute') as c", [role])).c), role).toBe(false);
    }
  });

  it("the trigger function is no one's to call", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, 'app.quote_timeline_entry()', 'execute') as c", [role])).c), role).toBe(false);
    }
  });
});
