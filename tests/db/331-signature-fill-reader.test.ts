import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Draft = { title: string; segments: { locked: boolean; text: string }[]; unfilled: string[] };

const DEAL_BODY = "חוזה {שם העסקה} עם {שם מלא}, טלפון {טלפון}, אימייל {אימייל}, חברה {שם החברה}.";
const CONTACT_BODY = "הסכם עם {שם פרטי} מחברת {שם החברה}, לחיוב: {כתובת לחיוב}.";

/**
 * RVW-77 (weekly review 2026-11-11): the server's fill of a document for signature (app.document_record_values, security
 * definer) takes a linked contact's or company's values only when the person reads that row by its select policy, as the
 * app's fill with the user's session does. Before, the check ran as the function owner and every existing id passed.
 */
describe("SGN-02 server fill reads linked records as the person (RVW-77)", () => {
  let owner: U, repA: U, repB: U;
  let org: string;
  let dealTemplate: string, contactTemplate: string;

  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const draft = (u: U, tpl: string, type: string, record: string, orgId = org) =>
    run(u, async (q) => (await one<{ d: Draft }>(q, "select public.signature_document_draft($1, $2, $3, $4) as d", [orgId, tpl, type, record])).d);
  const text = (d: Draft) => d.segments.map((s) => s.text).join("\n");
  const company = (ownerId: string, name: string, billing: string) =>
    asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, billing_address, owner_id) values ($1, $2, $3, $4) returning id", [org, name, billing, ownerId])).id,
    );
  const contact = (ownerId: string, first: string, companyId: string | null, extra: { phone?: string; email?: string; team?: string; org?: string } = {}) =>
    asAdmin(async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.contacts (organization_id, first_name, last_name, phone, email, company_id, owner_id, team_id) values ($1, $2, 'לוי', $3, $4, $5, $6, $7) returning id",
          [extra.org ?? org, first, extra.phone ?? null, extra.email ?? null, companyId, ownerId, extra.team ?? null],
        )
      ).id,
    );
  const deal = async (ownerId: string, contactId: string | null, companyId: string | null, orgId = org) => {
    const { pipelineId, stages } = await defaultPipeline(orgId);
    const open = stages.find((s) => s.kind === "open") ?? stages[0];
    return asAdmin(async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id, owner_id) values ($1, 'עסקת בדיקה', $2, $3, $4, $5, $6) returning id",
          [orgId, pipelineId, open.id, contactId, companyId, ownerId],
        )
      ).id,
    );
  };

  beforeAll(async () => {
    owner = await createUser("rvw77-owner");
    org = await createOrg(owner.id, "עסק המילוי");
    repA = await addMember(org, owner.id, "member", "rvw77-a");
    repB = await addMember(org, owner.id, "member", "rvw77-b");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ signatures: true })]));
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    await run(owner, (q) => q("update public.document_templates set body = $2 where organization_id = $1 and key = 'contract'", [org, DEAL_BODY]));
    await run(owner, (q) => q("update public.document_templates set body = $2 where organization_id = $1 and key = 'service_agreement'", [org, CONTACT_BODY]));
    dealTemplate = await run(owner, async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'contract'", [org])).id);
    contactTemplate = await run(owner, async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'service_agreement'", [org])).id);
  });

  it("a deal's contact and company hidden from the sender give no values; the owner, who reads them, gets them", async () => {
    const hiddenCompany = await company(repB.id, "חברה נסתרת", "רחוב סודי 1");
    const hiddenContact = await contact(repB.id, "נסתרת", hiddenCompany, { phone: "0501234567", email: "hidden@example.com" });
    const dealId = await deal(repA.id, hiddenContact, hiddenCompany);
    // the hidden rows are really hidden from rep A
    expect(await run(repA, async (q) => (await q("select 1 from public.contacts where id = $1", [hiddenContact])).rowCount)).toBe(0);

    const seen = await draft(repA, dealTemplate, "deal", dealId);
    const body = text(seen);
    expect(body).toContain("עסקת בדיקה");
    for (const secret of ["נסתרת", "0501234567", "hidden@example.com", "חברה נסתרת"]) expect(body).not.toContain(secret);
    expect(seen.unfilled.sort()).toEqual(["אימייל", "טלפון", "שם החברה", "שם מלא"].sort());

    const full = text(await draft(owner, dealTemplate, "deal", dealId));
    for (const value of ["נסתרת לוי", "0501234567", "hidden@example.com", "חברה נסתרת"]) expect(full).toContain(value);
  });

  it("a contact's company hidden from the sender gives no name or billing address", async () => {
    const hiddenCompany = await company(repB.id, "חברת הצד", "שדרה 5");
    const own = await contact(repA.id, "רותם", hiddenCompany);
    const seen = await draft(repA, contactTemplate, "contact", own);
    const body = text(seen);
    expect(body).toContain("רותם");
    expect(body).not.toContain("חברת הצד");
    expect(body).not.toContain("שדרה 5");
    expect(seen.unfilled.sort()).toEqual(["כתובת לחיוב", "שם החברה"].sort());
  });

  it("linked rows the sender reads are filled as before", async () => {
    const ownCompany = await company(repA.id, "החברה שלי", "דרך ראשית 7");
    const ownContact = await contact(repA.id, "יעל", ownCompany, { phone: "0527654321", email: "yael@example.com" });
    const dealId = await deal(repA.id, ownContact, ownCompany);
    const body = text(await draft(repA, dealTemplate, "deal", dealId));
    for (const value of ["יעל לוי", "0527654321", "yael@example.com", "החברה שלי"]) expect(body).toContain(value);
    const contactBody = text(await draft(repA, contactTemplate, "contact", ownContact));
    expect(contactBody).toContain("החברה שלי");
    expect(contactBody).toContain("דרך ראשית 7");
  });

  it("sending never stores hidden values: the server's own fill leaves them open, so the send is refused; the owner's send stores them", async () => {
    const hiddenCompany = await company(repB.id, "חברה חסויה", "סמטה 3");
    const hiddenContact = await contact(repB.id, "חסויה", hiddenCompany, { phone: "0539998887", email: "secret@example.com" });
    const dealId = await deal(repA.id, hiddenContact, hiddenCompany);
    const sendAs = (u: U, body: string) =>
      run(u, async (q) =>
        (await one<{ r: { id: string } }>(q, "select public.signature_document_send($1, $2, 'deal', $3, '', $4, null) as r", [org, dealTemplate, dealId, body])).r,
      );
    const drafted = await draft(repA, dealTemplate, "deal", dealId);
    expect(drafted.unfilled.length).toBeGreaterThan(0);
    // before RVW-77 the server's fill held the hidden values and this send stored them; now the fill is open and refused,
    // even when the sender writes over the open fields (send judges its own fill too)
    expect((await pgError(sendAs(repA, text(drafted)))).hint).toBe("signature_document:unfilled");
    expect((await pgError(sendAs(repA, text(drafted).replace(/\{[^{}\n]{1,30}\}/g, "לא ידוע")))).hint).toBe("signature_document:unfilled");
    expect(await asAdmin(async (q) => (await q("select 1 from public.signature_documents where deal_id = $1", [dealId])).rowCount)).toBe(0);

    // the owner reads the contact, so the server's fill is complete and the stored body holds the values
    const sent = await sendAs(owner, text(await draft(owner, dealTemplate, "deal", dealId)));
    const stored = await asAdmin((q) => one<{ body: string }>(q, "select body from public.signature_documents where id = $1", [sent.id]));
    for (const value of ["חסויה לוי", "0539998887", "secret@example.com", "חברה חסויה"]) expect(stored.body).toContain(value);
  });

  it("an HEB-08 deputy reads the absent person's linked contact during the absence, and its values are filled", async () => {
    const absentContact = await contact(repB.id, "מירב", null, { phone: "0541112223", email: "merav@example.com" });
    const dealId = await deal(repA.id, absentContact, null);
    // before the absence the contact is hidden from rep A
    expect(text(await draft(repA, dealTemplate, "deal", dealId))).not.toContain("0541112223");
    await asAdmin(async (q) => {
      await q("insert into public.tasks (organization_id, title, contact_id, owner_id) values ($1, 'לחזור ללקוחה', $2, $3)", [org, absentContact, repB.id]);
      await q(
        "insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id) values ($1, $2, current_date - 1, current_date + 1, 'vacation', $3)",
        [org, repB.id, repA.id],
      );
    });
    expect(await run(repA, async (q) => (await q("select 1 from public.contacts where id = $1", [absentContact])).rowCount)).toBe(1);
    const body = text(await draft(repA, dealTemplate, "deal", dealId));
    for (const value of ["מירב לוי", "0541112223", "merav@example.com"]) expect(body).toContain(value);
    await asAdmin((q) => q("delete from public.member_leaves where organization_id = $1 and user_id = $2", [org, repB.id]));
  });

  it("with team visibility a rep of the team gets a team record's values and a rep outside it does not", async () => {
    const teamOwner = await createUser("rvw77-t-owner");
    const teamOrg = await createOrg(teamOwner.id, "עסק הצוותים");
    const inTeam = await addMember(teamOrg, teamOwner.id, "member", "rvw77-t-in");
    const holder = await addMember(teamOrg, teamOwner.id, "member", "rvw77-t-holder");
    const outside = await addMember(teamOrg, teamOwner.id, "member", "rvw77-t-out");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [teamOrg, JSON.stringify({ signatures: true })]));
    await run(teamOwner, (q) => q("update public.organizations set record_visibility = 'team' where id = $1", [teamOrg]));
    await run(teamOwner, (q) => q("update public.document_templates set body = $2 where organization_id = $1 and key = 'contract'", [teamOrg, DEAL_BODY]));
    const tpl = await run(teamOwner, async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'contract'", [teamOrg])).id);
    const team = await asAdmin(async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.teams (organization_id, name) values ($1, 'צוות דרום') returning id", [teamOrg])).id;
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3), ($1, $2, $4)", [teamOrg, id, inTeam.id, holder.id]);
      return id;
    });
    const teamContact = await contact(holder.id, "גלית", null, { phone: "0556667778", email: "galit@example.com", team, org: teamOrg });
    const inDeal = await deal(inTeam.id, teamContact, null, teamOrg);
    const outDeal = await deal(outside.id, teamContact, null, teamOrg);

    const inBody = text(await draft(inTeam, tpl, "deal", inDeal, teamOrg));
    for (const value of ["גלית לוי", "0556667778", "galit@example.com"]) expect(inBody).toContain(value);
    const outBody = text(await draft(outside, tpl, "deal", outDeal, teamOrg));
    for (const secret of ["גלית", "0556667778", "galit@example.com"]) expect(outBody).not.toContain(secret);
  });
});
