import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, insertLead, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * The low database findings of the weekly review of 13 November 2026 (migration _review_1113_database.sql):
 * RVW-90 a converted lead's library links follow it to its contact; RVW-91 a library link, a message or a prefill link is
 * work for import undo; RVW-92 a cycle with a document does not go back to 'due' by its status alone; RVW-93 the rep of a
 * recurring billing is the first usable owner; RVW-95 the retention policy keeps a lead that acted (opened a link, sent back a form).
 */
describe("review 2026-11-13 database fixes", () => {
  let owner: U, member: U, away: U;
  let org: string;
  let item: string;
  const FEATURES = { recurring_billing: true, products: true, documents: true, payments: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  // fixtures the server writes (links, entries, requests): written with the triggers off, test only
  const raw = <T>(fn: (q: Query) => Promise<T>) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      return fn(q);
    });
  const newContact = (ownerId: string | null = null) =>
    asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, ownerId ?? owner.id])).id,
    );
  const link = (column: string, id: string) =>
    raw(async (q) =>
      (await one<{ id: string }>(q, `insert into public.library_links (organization_id, library_item_id, ${column}, created_by) values ($1, $2, $3, $4) returning id`, [org, item, id, owner.id])).id,
    );
  const worked = (type: string, id: string) =>
    asAdmin(async (q) =>
      (await one<{ w: boolean }>(q, "select app.import_record_worked($1, $2, $3, now() - interval '1 hour', gen_random_uuid()) as w", [org, type, id])).w,
    );

  beforeAll(async () => {
    owner = await createUser("r1113-owner");
    org = await createOrg(owner.id, "עסק הסקירה");
    member = await addMember(org, owner.id, "member", "r1113-member");
    away = await addMember(org, owner.id, "member", "r1113-away");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    item = await raw(async (q) =>
      (await one<{ id: string }>(q, "insert into public.library_items (organization_id, kind, title, url) values ($1, 'link', 'מדריך', 'https://example.com/guide') returning id", [org])).id,
    );
  });

  it("RVW-90: a converted lead's library links move to its contact", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד שהומר", phone: "050-7311001" });
    const other = await insertLead(owner.id, org, { full_name: "ליד אחר", phone: "050-7311002" });
    const l1 = await link("lead_id", lead);
    const l2 = await link("lead_id", other);
    const contact = await newContact();
    await asAdmin((q) => q("update public.leads set converted_at = now(), converted_contact_id = $2 where id = $1", [lead, contact]));
    const rows = await asAdmin(async (q) =>
      (await q<{ id: string; lead_id: string | null; contact_id: string | null }>("select id, lead_id, contact_id from public.library_links where id = any($1)", [[l1, l2]])).rows,
    );
    expect(rows.find((r) => r.id === l1)).toMatchObject({ lead_id: null, contact_id: contact });
    // another lead's link stays where it is
    expect(rows.find((r) => r.id === l2)).toMatchObject({ lead_id: other, contact_id: null });
    // the contact's card reads it now (the activities rule)
    expect(await asUser(owner.id, async (q) => (await q("select 1 from public.library_links where contact_id = $1", [contact])).rowCount)).toBe(1);
  });

  it("RVW-90 backfill (owner (372) ב): links already sitting on a converted lead move to its contact; a second run changes nothing", async () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_library_links_converted_backfill.sql"));
    expect(file).toBeDefined();
    const sql = readFileSync(join(dir, file!), "utf8");
    const lead = await insertLead(owner.id, org, { full_name: "הומר לפני התיקון", phone: "050-7311031" });
    const open = await insertLead(owner.id, org, { full_name: "לא הומר", phone: "050-7311032" });
    const contact = await newContact();
    // converted the old way: the trigger did not exist yet (triggers off)
    await raw((q) => q("update public.leads set converted_at = now(), converted_contact_id = $2 where id = $1", [lead, contact]));
    const moved = await link("lead_id", lead);
    const kept = await link("lead_id", open);
    const where = (id: string) =>
      asAdmin(async (q) => one<{ lead_id: string | null; contact_id: string | null }>(q, "select lead_id, contact_id from public.library_links where id = $1", [id]));
    expect(await where(moved)).toMatchObject({ lead_id: lead, contact_id: null });
    await asAdmin((q) => q(sql));
    expect(await where(moved)).toMatchObject({ lead_id: null, contact_id: contact });
    expect(await where(kept)).toMatchObject({ lead_id: open, contact_id: null });
    await asAdmin((q) => q(sql));
    expect(await where(moved)).toMatchObject({ lead_id: null, contact_id: contact });
  });

  it("RVW-90: a lead merge sends the duplicate's links to the kept lead's contact when either side is converted", async () => {
    const where = (id: string) =>
      asAdmin(async (q) => one<{ lead_id: string | null; contact_id: string | null }>(q, "select lead_id, contact_id from public.library_links where id = $1", [id]));
    const merge = (keep: string, dup: string) => asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep, dup]));

    // (A) the kept lead is converted, the duplicate is not
    const keepA = await insertLead(owner.id, org, { full_name: "שמור מומר", phone: "050-7311021" });
    const dupA = await insertLead(owner.id, org, { full_name: "כפול", phone: "050-7311022" });
    const contactA = await newContact();
    await asAdmin((q) => q("update public.leads set converted_at = now(), converted_contact_id = $2 where id = $1", [keepA, contactA]));
    const linkA = await link("lead_id", dupA);
    await merge(keepA, dupA);
    expect(await where(linkA)).toEqual({ lead_id: null, contact_id: contactA });

    // (B) the duplicate is converted: its conversion passes to the kept lead, and both leads' links reach the contact
    const keepB = await insertLead(owner.id, org, { full_name: "שמור", phone: "050-7311023" });
    const dupB = await insertLead(owner.id, org, { full_name: "כפול מומר", phone: "050-7311024" });
    const contactB = await newContact();
    await asAdmin((q) => q("update public.leads set converted_at = now(), converted_contact_id = $2 where id = $1", [dupB, contactB]));
    const ownB = await link("lead_id", keepB);
    const dupLinkB = await link("lead_id", dupB);
    await merge(keepB, dupB);
    expect(await where(ownB)).toEqual({ lead_id: null, contact_id: contactB });
    expect(await where(dupLinkB)).toEqual({ lead_id: null, contact_id: contactB });

    // neither converted: the duplicate's links go to the kept lead, as before
    const keepC = await insertLead(owner.id, org, { full_name: "שמור רגיל", phone: "050-7311025" });
    const dupC = await insertLead(owner.id, org, { full_name: "כפול רגיל", phone: "050-7311026" });
    const linkC = await link("lead_id", dupC);
    await merge(keepC, dupC);
    expect(await where(linkC)).toEqual({ lead_id: keepC, contact_id: null });
  });

  it("RVW-91: a library link, a message or a prefill link is work for import undo", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד מיובא", phone: "050-7311003" });
    expect(await worked("lead", lead)).toBe(false);
    await link("lead_id", lead);
    expect(await worked("lead", lead)).toBe(true);

    const messaged = await insertLead(owner.id, org, { full_name: "ליד עם הודעה", phone: "050-7311004" });
    expect(await worked("lead", messaged)).toBe(false);
    await raw((q) => q("insert into public.messages (organization_id, lead_id, channel, direction, status) values ($1, $2, 'sms', 'outbound', 'sent')", [org, messaged]));
    expect(await worked("lead", messaged)).toBe(true);

    const contact = await newContact();
    expect(await worked("contact", contact)).toBe(false);
    await raw((q) => q("insert into app.prefill_links (organization_id, prefill_form_id, contact_id) values ($1, gen_random_uuid(), $2)", [org, contact]));
    expect(await worked("contact", contact)).toBe(true);

    const messagedContact = await newContact();
    await raw((q) => q("insert into public.messages (organization_id, contact_id, channel, direction, status) values ($1, $2, 'email', 'inbound', 'received')", [org, messagedContact]));
    expect(await worked("contact", messagedContact)).toBe(true);

    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה מיובאת', $2, $3) returning id", [org, pipelineId, stages[0].id])).id,
    );
    expect(await worked("deal", deal)).toBe(false);
    await link("deal_id", deal);
    expect(await worked("deal", deal)).toBe(true);
  });

  it("RVW-92: a cycle with a document goes back to 'due' only by removing the document", async () => {
    const contact = await newContact();
    const billing = await raw(async (q) =>
      (await one<{ id: string }>(q, "insert into public.recurring_billings (organization_id, contact_id, name, cycle, start_date, billing_day, prices_include_vat) values ($1, $2, 'ריטיינר', 'monthly', current_date, 1, false) returning id", [org, contact])).id,
    );
    const doc = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', 'R1113-1', 100) returning id", [org, contact])).id,
    );
    const cycle = await raw(async (q) =>
      (await one<{ id: string }>(q, "insert into public.recurring_billing_cycles (organization_id, billing_id, cycle_on, period_end, net_agorot, vat_agorot, total_agorot, status, accounting_document_id, documented_at) values ($1, $2, current_date, current_date + 30, 100, 0, 100, 'documented', $3, now()) returning id", [org, billing, doc])).id,
    );
    const err = await pgError(asUser(owner.id, (q) => q("update public.recurring_billing_cycles set status = 'due' where id = $1", [cycle])));
    expect(err.hint).toBe("recurring_cycle:due_document");
    // removing the document still moves it back to waiting
    await asUser(owner.id, (q) => q("update public.recurring_billing_cycles set accounting_document_id = null where id = $1", [cycle]));
    expect(await asAdmin(async (q) => (await one<{ s: string; d: string | null }>(q, "select status as s, accounting_document_id as d from public.recurring_billing_cycles where id = $1", [cycle])))).toEqual({ s: "due", d: null });
  });

  it("RVW-93: the rep is the first usable of the deal's, the contact's and the company's owner", async () => {
    const contact = await newContact(member.id);
    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await raw(async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [org, pipelineId, stages[0].id, away.id, contact])).id,
    );
    const billing = await raw(async (q) =>
      (await one<{ id: string }>(q, "insert into public.recurring_billings (organization_id, contact_id, deal_id, name, cycle, start_date, billing_day, prices_include_vat) values ($1, $2, $3, 'מנוי', 'monthly', current_date, 1, false) returning id", [org, contact, deal])).id,
    );
    const rep = () => asAdmin(async (q) => (await one<{ r: string }>(q, "select app.recurring_billing_rep($1, $2) as r", [org, billing])).r);
    // the deal's owner while usable
    expect(await rep()).toBe(away.id);
    // suspended: the contact's owner, not the business's owner
    await raw((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, away.id]));
    expect(await rep()).toBe(member.id);
    // neither usable: the business's owner
    await raw((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, member.id]));
    expect(await rep()).toBe(owner.id);
    await raw((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = any($2)", [org, [member.id, away.id]]));
  });

  it("RVW-95: the retention policy keeps a lead that opened a link or sent back a form, not one that was only asked for a review (owner (371) ב)", async () => {
    const old = async (name: string, phone: string) => {
      const id = await insertLead(owner.id, org, { full_name: name, phone });
      await raw((q) => q("update public.leads set created_at = now() - interval '13 months' where id = $1", [id]));
      return id;
    };
    const candidate = (lead: string) =>
      asAdmin(async (q) => (await q("select 1 from app.lead_retention_candidates($1, now() - interval '12 months', $2)", [org, lead])).rowCount);
    const viewed = await old("פתח קישור", "050-7311011");
    const filled = await old("מילא טופס", "050-7311012");
    const asked = await old("בקשת ביקורת", "050-7311013");
    const refused = await old("ביקורת שלא נשלחה", "050-7311014");
    const stale = await old("פתח מזמן", "050-7311015");
    for (const id of [viewed, filled, asked, refused, stale]) expect(await candidate(id)).toBe(1);

    await raw(async (q) => {
      for (const [id, kind, at] of [[viewed, "library_viewed", "now()"], [filled, "prefill_submitted", "now()"], [stale, "library_viewed", "now() - interval '13 months'"]]) {
        await q(`insert into public.activities (organization_id, lead_id, type, body, metadata, created_at, occurred_at) values ($1, $2, 'system', 'x', jsonb_build_object('kind', $3::text), ${at}, ${at})`, [org, id, kind]);
      }
      await q("insert into app.review_requests (organization_id, source_kind, source_id, lead_id, outcome, channel) values ($1, 'meeting', gen_random_uuid(), $2, 'queued', 'sms')", [org, asked]);
      await q("insert into app.review_requests (organization_id, source_kind, source_id, lead_id, outcome) values ($1, 'meeting', gen_random_uuid(), $2, 'no_consent')", [org, refused]);
    });
    expect(await candidate(viewed)).toBe(0);
    expect(await candidate(filled)).toBe(0);
    // owner (371) ב: a review request sent to the lead keeps nothing; neither does an opening before the cutoff
    expect(await candidate(asked)).toBe(1);
    expect(await candidate(refused)).toBe(1);
    expect(await candidate(stale)).toBe(1);
  });
});
