import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Notice = { type: string; title: string; body: string | null };

/**
 * RVW-42: a privacy erasure of a quote's customer also cleans the notices about that quote (entity_type 'quote'): the cancel
 * reason of an accepted quote leaves the body, and the quote's title (which may name the customer) leaves the title, as the
 * erasure already does for the quote itself, its timeline entry and the order notices.
 */
describe("erasing a quote's customer cleans the quote's notices (RVW-42)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const notices = (quote: string) =>
    asAdmin(
      async (q) =>
        (await q<Notice>("select type, title, body from public.notifications where entity_type = 'quote' and entity_id = $1 order by type, title", [quote]))
          .rows,
    );

  beforeAll(async () => {
    owner = await createUser("eqn-owner");
    org = await createOrg(owner.id, "עסק ההתראות");
    member = await addMember(org, owner.id, "member", "eqn-member");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: true })]));
    await asUser(owner.id, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [org]));
    const pipe = await asAdmin((q) =>
      one<{ p: string; s: string }>(
        q,
        "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1",
        [org],
      ),
    );
    pipelineId = pipe.p;
    stageId = pipe.s;
  });

  it("the reason and the title leave every notice of the quote; other quotes' notices stay", async () => {
    const make = (name: string) =>
      asUser(member.id, async (q) => {
        const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, member.id])).id;
        const deal = (
          await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עבודה', $2, $3, $4, $5) returning id", [
            org,
            pipelineId,
            stageId,
            contact,
            member.id,
          ])
        ).id;
        const quote = (
          await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, $2, $3, $4) returning id", [
            org,
            `שיפוץ הדירה של ${name} כהן`,
            deal,
            contact,
          ])
        ).id;
        await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 100)", [org, quote]);
        await q("select public.quote_send($1, $2)", [org, quote]);
        return { contact, quote };
      });
    const erased = await make("יעל");
    const other = await make("רון");
    for (const ids of [erased, other]) {
      await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [ids.quote]));
      // the real notice: "הצעת מחיר שאושרה בוטלה: <title>", body "הצעה <n> · סיבה: <reason>", to the quote's owner
      await asUser(owner.id, (q) => q("select public.quote_cancel_accepted($1, $2, $3)", [org, ids.quote, `${ids === erased ? "יעל" : "רון"} כהן ביקשה לבטל`]));
      // the other notices about a quote, as app.quote_mark_viewed, quote_public_decide and app.expire_quotes write them
      await asAdmin(async (q) => {
        const t = (await one<{ title: string }>(q, "select title from public.quotes where id = $1", [ids.quote])).title;
        await q(
          `insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id) values
             ($1, $2, 'quote_viewed', 'הלקוח פתח את הצעת המחיר 1001', $3, 'quote', $4),
             ($1, $2, 'quote', 'הצעת מחיר אושרה: ' || $3, 'הצעה 1001 · להעביר את העסקה לזכייה ולעדכן את השורות?', 'quote', $4),
             ($1, $2, 'quote', 'פג תוקפה של הצעת מחיר: ' || $3, 'הצעה 1001', 'quote', $4)`,
          [org, member.id, t, ids.quote],
        );
      });
    }
    const before = await notices(erased.quote);
    expect(before.find((n) => n.title.startsWith("הצעת מחיר שאושרה בוטלה"))?.body).toContain("סיבה: יעל כהן");

    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [erased.contact]);
      await q("delete from public.contacts where id = $1", [erased.contact]);
    });
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, erased.contact]));

    const after = await notices(erased.quote);
    expect(after).toHaveLength(4);
    for (const n of after) {
      expect(`${n.title} ${n.body ?? ""}`, n.title).not.toContain("יעל");
      expect(`${n.title} ${n.body ?? ""}`, n.title).not.toContain("סיבה");
    }
    expect(after).toEqual([
      { type: "quote", title: "הצעת מחיר אושרה: הצעת מחיר", body: "הצעה 1001 · להעביר את העסקה לזכייה ולעדכן את השורות?" },
      { type: "quote", title: "הצעת מחיר שאושרה בוטלה: הצעת מחיר", body: expect.stringMatching(/^הצעה \S+$/) },
      { type: "quote", title: "פג תוקפה של הצעת מחיר: הצעת מחיר", body: "הצעה 1001" },
      { type: "quote_viewed", title: "הלקוח פתח את הצעת המחיר 1001", body: null },
    ]);
    // another customer's quote keeps its notices as they were
    const kept = await notices(other.quote);
    expect(kept.filter((n) => `${n.title} ${n.body ?? ""}`.includes("רון"))).toHaveLength(4);
  });
});
