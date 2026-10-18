import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { QUOTE_LINK_TOKEN } from "@/features/quotes/public";
import { currentNameIfChanged, quoteCustomerName, type CustomerNameParts } from "@/features/quotes/share";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * QUO-08 and QUO-07 point 9 (owner, 18 October 2026). The quote page shows "השם הנוכחי" beside the name a sent quote was
 * printed with, computed in the app by quoteCustomerName(); it must follow public.quote_send()'s rule exactly, or every
 * sent quote would show a false "current name". Sending and then making the customer's link, as the send window does,
 * works for whoever may send.
 */
describe("the printed customer name and today's (QUO-08, QUO-07)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const company = (name: string, billing: string | null) =>
    asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, billing_name) values ($1, $2, $3) returning id", [org, name, billing])).id,
    );
  const contact = (first: string, billing: string | null, companyId: string | null) =>
    asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, billing_name, company_id) values ($1, $2, $3, $4) returning id", [
          org,
          first,
          billing,
          companyId,
        ])
      ).id,
    );
  // a sent deal quote; the quote takes the deal's contact and company
  const sentQuote = (u: U, contactId: string | null, companyId: string | null) =>
    asUser(u.id, async (q) => {
      const deal = (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id",
          [org, pipelineId, stageId, contactId, companyId],
        )
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 10000)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      return quote;
    });

  // the parts as the app reads them, all visible here (the owner reads everything)
  const partsNow = (quoteId: string) =>
    asAdmin(async (q): Promise<{ printed: string | null; parts: CustomerNameParts }> => {
      const quote = await one<{ customer_name: string | null; contact_id: string | null; company_id: string | null }>(
        q,
        "select customer_name, contact_id, company_id from public.quotes where id = $1",
        [quoteId],
      );
      const c = quote.contact_id
        ? await one<{ full_name: string | null; billing_name: string | null; company_id: string | null }>(q, "select full_name, billing_name, company_id from public.contacts where id = $1", [
            quote.contact_id,
          ])
        : null;
      const cc = c?.company_id ? await one<{ name: string; billing_name: string | null }>(q, "select name, billing_name from public.companies where id = $1", [c.company_id]) : null;
      const co = quote.company_id ? await one<{ name: string }>(q, "select name from public.companies where id = $1", [quote.company_id]) : null;
      return {
        printed: quote.customer_name,
        parts: {
          contact: c ? { fullName: c.full_name, billingName: c.billing_name, companyId: c.company_id } : null,
          contactCompany: cc ? { name: cc.name, billingName: cc.billing_name } : null,
          company: co ? { name: co.name } : null,
        },
      };
    });

  beforeAll(async () => {
    owner = await createUser("qs-owner");
    org = await createOrg(owner.id, "עסק השליחות");
    member = await addMember(org, owner.id, "member", "qs-member");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("the app's rule gives the name quote_send printed, in every order of the rule", async () => {
    const withBilling = await company("חברה עם שם לחשבונית", "חברה בע\"מ לחשבונית");
    const plain = await company("חברה פשוטה", null);
    const dealCompany = await company("חברת העסקה", "לא בשימוש");
    const cases: Array<{ contact: string | null; company: string | null; expected: string | null }> = [
      // the contact's own name for invoices comes first
      { contact: await contact("אורי", "אורי לחשבונית", withBilling), company: null, expected: "אורי לחשבונית" },
      // then its company's name for invoices
      { contact: await contact("בתיה", null, withBilling), company: null, expected: "חברה בע\"מ לחשבונית" },
      // then its company
      { contact: await contact("גיל", null, plain), company: null, expected: "חברה פשוטה" },
      // a contact with no company: the quote's company (its name, never its name for invoices)
      { contact: await contact("דנה", null, null), company: dealCompany, expected: "חברת העסקה" },
      // the contact's company wins over the quote's
      { contact: await contact("הדר", null, plain), company: dealCompany, expected: "חברה פשוטה" },
      // only a contact
      { contact: await contact("ורד", null, null), company: null, expected: "ורד" },
      // only a company
      { contact: null, company: plain, expected: "חברה פשוטה" },
      // neither
      { contact: null, company: null, expected: null },
    ];
    for (const [i, c] of cases.entries()) {
      const quote = await sentQuote(member, c.contact, c.company);
      const { printed, parts } = await partsNow(quote);
      expect(printed, `case ${i}`).toBe(c.expected);
      expect(quoteCustomerName(parts), `case ${i}`).toBe(printed);
      expect(currentNameIfChanged(printed, quoteCustomerName(parts)), `case ${i}`).toBeNull();
    }
  });

  it("a rename after sending keeps the printed name and shows today's beside it", async () => {
    const co = await company("סטודיו ירח", null);
    const person = await contact("זיו", null, co);
    const quote = await sentQuote(member, person, null);
    await asUser(owner.id, (q) => q("update public.companies set billing_name = 'ירח הפקות בע\"מ' where id = $1", [co]));
    const { printed, parts } = await partsNow(quote);
    expect(printed).toBe("סטודיו ירח");
    expect(currentNameIfChanged(printed, quoteCustomerName(parts))).toBe("ירח הפקות בע\"מ");
  });

  it("whoever sends a quote can make its customer link right after, as the send window does", async () => {
    const person = await contact("חן", null, null);
    const quote = await sentQuote(member, person, null);
    const token = await asUser(member.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
    expect(token).toMatch(QUOTE_LINK_TOKEN);
    const status = await asUser(member.id, async (q) => (await one<{ s: { active: boolean } }>(q, "select public.quote_link_status($1, $2) as s", [org, quote])).s);
    expect(status.active).toBe(true);
  });
});
