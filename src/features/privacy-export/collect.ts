import "server-only";

import { FILES_BUCKET } from "@/features/files/types";
import { getUserNames } from "@/features/shell/queries";
import { readAllPages } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import { countRows, personLinkFilter, uniqueIds, withoutOthersPrivate, type PersonIds, type PersonKind, type Row, type StoredFile } from "./build";

// consents: the address hash is never selectable; form inquiries: no IP hash or browser
const CONSENT_COLUMNS =
  "id, seq, lead_id, contact_id, subject_type, subject_id, channel, state, source, wording, method, copied_from, lift_method, lift_note, recorded_by, created_at";
const SUBMISSION_COLUMNS = "id, form_id, form_name, status, lead_id, payload, created_at";
const FILE_COLUMNS =
  "id, name, mime_type, size_bytes, lead_id, contact_id, deal_id, activity_id, previous_id, accounting_document_id, payment_id, uploaded_by, created_at, storage_path";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type PersonExport = {
  data: Row;
  rows: number;
  // read later, one at a time, while the ZIP streams
  files: StoredFile[];
};

class ReadError extends Error {}

function check<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error) throw new ReadError(`${what}: ${result.error.message}`);
  return (result.data ?? []) as T;
}

/** Every row of `table` in the business that matches `filter` (a PostgREST `or`), read with the user's session, by id. */
async function readLinked(supabase: Supabase, orgId: string, table: string, columns: string, filter: string | null, order = "id"): Promise<Row[]> {
  if (!filter) return [];
  const { rows } = await readAllPages<Row>(async (from, to) => {
    const { data, error } = await supabase
      .from(table as "activities")
      .select(columns)
      .eq("organization_id", orgId)
      .or(filter)
      .order(order as "id", { ascending: true })
      .range(from, to);
    if (error) throw new ReadError(`${table}: ${error.message}`);
    return data as unknown as Row[];
  });
  return rows;
}

async function readByIds(supabase: Supabase, orgId: string, table: string, columns: string, column: string, ids: string[], order = "id"): Promise<Row[]> {
  if (!ids.length) return [];
  return readLinked(supabase, orgId, table, columns, `${column}.in.(${ids.join(",")})`, order);
}

/**
 * Everything the business holds about one lead or contact, read with the user's session (RLS decides what is in it),
 * or null when the record is not there for this user. The person is the record plus the records made from it by
 * conversion (a lead's contact and deal; a contact's leads), and the deals linked to the contact.
 */
export async function collectPerson(orgId: string, kind: PersonKind, id: string, userId: string): Promise<PersonExport | null> {
  const supabase = await createClient();

  // 1. the person's records
  let leads: Row[] = [];
  let contacts: Row[] = [];
  if (kind === "lead") {
    const lead = check(await supabase.from("leads").select("*").eq("organization_id", orgId).eq("id", id).maybeSingle(), "lead");
    if (!lead || Array.isArray(lead)) return null;
    leads = [lead as Row];
    const contactId = (lead as Row).converted_contact_id;
    if (typeof contactId === "string") {
      contacts = await readByIds(supabase, orgId, "contacts", "*", "id", [contactId]);
    }
  } else {
    const contact = check(await supabase.from("contacts").select("*").eq("organization_id", orgId).eq("id", id).maybeSingle(), "contact");
    if (!contact || Array.isArray(contact)) return null;
    contacts = [contact as Row];
  }
  const contactIds = uniqueIds(contacts.map((c) => c.id));
  // every lead converted into one of the contacts (the root lead included once)
  const converted = await readByIds(supabase, orgId, "leads", "*", "converted_contact_id", contactIds);
  const leadIds = uniqueIds([...leads.map((l) => l.id), ...converted.map((l) => l.id)]);
  leads = [...leads, ...converted.filter((l) => !leads.some((x) => x.id === l.id))];

  // 2. deals: the contact's own and the deals made by converting the leads. A deal the person is only a further
  // contact on is listed as a link (deal_contacts), without its timeline, which is about other people too.
  const dealContacts = await readByIds(supabase, orgId, "deal_contacts", "*", "contact_id", contactIds, "deal_id");
  const ownDeals = await readByIds(supabase, orgId, "deals", "id", "contact_id", contactIds);
  const dealIds = uniqueIds([...ownDeals.map((d) => d.id), ...leads.map((l) => l.converted_deal_id)]);
  const deals = await readByIds(supabase, orgId, "deals", "*", "id", dealIds);
  const ids: PersonIds = { lead: leadIds, contact: contactIds, deal: uniqueIds(deals.map((d) => d.id)) };
  const linked = personLinkFilter(ids);
  const personOnly = personLinkFilter({ ...ids, deal: [] });

  // 3. everything linked to them
  const [contactChannels, contactCompanies, allActivities, tasks, meetings, allFiles, consents, submissions] = await Promise.all([
    readByIds(supabase, orgId, "contact_channels", "*", "contact_id", contactIds),
    readByIds(supabase, orgId, "contact_companies", "*", "contact_id", contactIds),
    readLinked(supabase, orgId, "activities", "*", linked),
    readLinked(supabase, orgId, "tasks", "*", linked),
    readLinked(supabase, orgId, "meetings", "*", linked),
    readLinked(supabase, orgId, "files", FILE_COLUMNS, linked),
    readLinked(supabase, orgId, "consents", CONSENT_COLUMNS, personOnly),
    readByIds(supabase, orgId, "form_submissions", SUBMISSION_COLUMNS, "lead_id", leadIds),
  ]);
  // someone else's private note and its files stay out, even for an admin who may read them on screen
  const { activities, files } = withoutOthersPrivate(allActivities, allFiles, userId);
  const relationFilter = [
    contactIds.length ? `contact_id.in.(${contactIds.join(",")})` : null,
    contactIds.length ? `related_contact_id.in.(${contactIds.join(",")})` : null,
    leadIds.length ? `lead_id.in.(${leadIds.join(",")})` : null,
  ]
    .filter(Boolean)
    .join(",");
  const relations = await readLinked(supabase, orgId, "contact_relations", "*", relationFilter || null);
  const quoteFilter = [
    contactIds.length ? `contact_id.in.(${contactIds.join(",")})` : null,
    ids.deal.length ? `deal_id.in.(${ids.deal.join(",")})` : null,
  ]
    .filter(Boolean)
    .join(",");
  const quotes = await readLinked(supabase, orgId, "quotes", "*", quoteFilter || null);
  const quoteIds = uniqueIds(quotes.map((q) => q.id));
  // RVW-33: the customer's decision (signer, ID, signature, IP and browser, or the decline reason; owners and admins
  // read it, RLS), the views and the payment schedule of the person's quotes, and the static segments they are in
  const [quoteLines, quoteDecisions, quoteViews, quotePaymentSteps, segmentMembers] = await Promise.all([
    readByIds(supabase, orgId, "quote_lines", "*", "quote_id", quoteIds),
    readByIds(supabase, orgId, "quote_decisions", "*", "quote_id", quoteIds),
    readByIds(supabase, orgId, "quote_views", "*", "quote_id", quoteIds),
    readByIds(supabase, orgId, "quote_payment_steps", "*", "quote_id", quoteIds),
    readLinked(supabase, orgId, "segment_members", "*", personOnly),
  ]);
  // ORD-01: the person's orders (as the customer or the delivery contact, or on their deals) and their lines
  const orderFilter = [
    contactIds.length ? `contact_id.in.(${contactIds.join(",")})` : null,
    contactIds.length ? `delivery_contact_id.in.(${contactIds.join(",")})` : null,
    ids.deal.length ? `deal_id.in.(${ids.deal.join(",")})` : null,
  ]
    .filter(Boolean)
    .join(",");
  const orders = await readLinked(supabase, orgId, "orders", "*", orderFilter || null);
  // ORD-04: and their payment schedule
  const orderIds = uniqueIds(orders.map((o) => o.id));
  // ORD-05: and the customer's answers on them (owners and admins read them, RLS)
  const [orderLines, orderPaymentSteps, orderDecisions] = await Promise.all([
    readByIds(supabase, orgId, "order_lines", "*", "order_id", orderIds),
    readByIds(supabase, orgId, "order_payment_steps", "*", "order_id", orderIds),
    readByIds(supabase, orgId, "order_decisions", "*", "order_id", orderIds),
  ]);
  // DOC-01: the accounting documents recorded on the person's contacts and deals
  const documentFilter = [contactIds.length ? `contact_id.in.(${contactIds.join(",")})` : null, ids.deal.length ? `deal_id.in.(${ids.deal.join(",")})` : null]
    .filter(Boolean)
    .join(",");
  const accountingDocuments = await readLinked(supabase, orgId, "accounting_documents", "*", documentFilter || null);
  // PAY-01: the payments recorded on the person's contacts and deals
  const paymentFilter = [contactIds.length ? `contact_id.in.(${contactIds.join(",")})` : null, ids.deal.length ? `deal_id.in.(${ids.deal.join(",")})` : null]
    .filter(Boolean)
    .join(",");
  const payments = await readLinked(supabase, orgId, "payments", "*", paymentFilter || null);
  // and their files (a receipt or a confirmation), listed and stored like the records' files
  files.push(...(await readByIds(supabase, orgId, "files", FILE_COLUMNS, "payment_id", uniqueIds(payments.map((p) => p.id)))));
  // and their files (the copy of the paper that was issued), listed and stored like the records' files
  files.push(...(await readByIds(supabase, orgId, "files", FILE_COLUMNS, "accounting_document_id", uniqueIds(accountingDocuments.map((d) => d.id)))));

  // 4. names for the ids, so the file can be read without the system
  const companyIds = uniqueIds([...contacts.map((c) => c.company_id), ...contactCompanies.map((c) => c.company_id), ...deals.map((d) => d.company_id)]);
  const [companies, statuses, sources, stages, pipelines, fields, relationTypes, segments] = await Promise.all([
    readByIds(supabase, orgId, "companies", "id, name", "id", companyIds),
    readLinked(supabase, orgId, "lead_statuses", "id, name", "id.not.is.null"),
    readLinked(supabase, orgId, "lead_sources", "id, name", "id.not.is.null"),
    readLinked(supabase, orgId, "stages", "id, name, pipeline_id", "id.not.is.null"),
    readLinked(supabase, orgId, "pipelines", "id, name", "id.not.is.null"),
    readLinked(supabase, orgId, "field_definitions", "id, object_type, key, label", "id.not.is.null"),
    relations.length ? readLinked(supabase, orgId, "contact_relation_types", "id, name, reverse_name", "id.not.is.null") : Promise.resolve([]),
    readByIds(supabase, orgId, "segments", "id, name", "id", uniqueIds(segmentMembers.map((m) => m.segment_id))),
  ]);
  const userIds = [...leads, ...contacts, ...deals, ...activities, ...tasks, ...meetings, ...quotes, ...orders].flatMap((r) => [r.owner_id, r.created_by, r.updated_by]);
  const userNames = await getUserNames(
    uniqueIds([...userIds, ...files.map((f) => f.uploaded_by), ...consents.map((c) => c.recorded_by), ...segmentMembers.map((m) => m.added_by)]).filter((u): u is string => typeof u === "string"),
  );

  const sections = {
    people: { leads, contacts },
    deals,
    deal_contacts: dealContacts,
    contact_channels: contactChannels,
    contact_companies: contactCompanies,
    contact_relations: relations,
    activities,
    tasks,
    meetings,
    // the storage path is internal; the file itself is in the folder files
    files: files.map((f) => {
      const copy = { ...f };
      delete copy.storage_path;
      return copy;
    }),
    quotes,
    quote_lines: quoteLines,
    quote_decisions: quoteDecisions,
    quote_views: quoteViews,
    quote_payment_steps: quotePaymentSteps,
    orders,
    order_lines: orderLines,
    order_payment_steps: orderPaymentSteps,
    payments,
    order_decisions: orderDecisions,
    accounting_documents: accountingDocuments,
    segment_members: segmentMembers,
    consents,
    form_submissions: submissions,
    lookups: {
      users: Object.fromEntries(userNames),
      companies: Object.fromEntries(companies.map((c) => [c.id, c.name])),
      lead_statuses: Object.fromEntries(statuses.map((s) => [s.id, s.name])),
      lead_sources: Object.fromEntries(sources.map((s) => [s.id, s.name])),
      pipelines: Object.fromEntries(pipelines.map((p) => [p.id, p.name])),
      stages: Object.fromEntries(stages.map((s) => [s.id, s.name])),
      segments: Object.fromEntries(segments.map((g) => [g.id, g.name])),
      relation_types: Object.fromEntries(relationTypes.map((t) => [t.id, { name: t.name, reverse_name: t.reverse_name }])),
      custom_fields: fields.map((f) => ({ object_type: f.object_type, key: f.key, label: f.label })),
    },
  };
  const rows = leads.length + contacts.length + countRows(sections);
  const data: Row = { kind, id, exported_at: new Date().toISOString(), ...sections };
  const stored: StoredFile[] = files.map((f) => ({ id: String(f.id), name: String(f.name), path: String(f.storage_path), declaredBytes: Number(f.size_bytes ?? 0) }));
  return { data, rows, files: stored };
}

/**
 * One stored file, read with the user's session (Storage follows the same rules); null when it cannot be read. The
 * client is made before the response starts, since the stream reads after the request handler has returned.
 */
export async function readStoredFile(supabase: Supabase, path: string): Promise<Uint8Array | null> {
  const { data: blob, error } = await supabase.storage.from(FILES_BUCKET).download(path);
  if (error || !blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

export { ReadError as PersonExportReadError };
