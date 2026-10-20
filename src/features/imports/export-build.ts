// The pure part of the full export (SPEC 12.4): which tables go in, how a table
// becomes a CSV, and the readable names put next to ids. No database here, so
// the unit tests can check it; export.ts reads the rows and builds the ZIP.

import { OCCASIONS } from "@/features/calendar-days/holidays";
import { channelTypeLabel } from "@/features/contacts/channels";
import { dealContactRoleLabel } from "@/features/deal-contacts/roles";
import { WEEKDAYS_LONG } from "@/lib/calendar-grid";
import { csvText } from "@/lib/csv";
import type { Database, Json } from "@/lib/database.types";

type Tables = Database["public"]["Tables"];

type Row<K extends keyof Tables> = Tables[K]["Row"];

// A table whose rows carry organization_id and created_at can be exported: the
// read filters by the first and pages in created_at order, ties broken by the
// row's key. Most tables are keyed by id; a link table without one (team_members,
// deal_contacts) names its primary key columns instead.
type WithId = {
  [K in keyof Tables]: Row<K> extends { organization_id: string; id: string; created_at: string } ? K : never;
}[keyof Tables];
type WithoutId = {
  [K in keyof Tables]: Row<K> extends { organization_id: string; created_at: string } ? (Row<K> extends { id: string } ? never : K) : never;
}[keyof Tables];

export type ExportTableName = WithId | WithoutId;

export type ExportTable =
  | { table: WithId; file: string }
  | { [K in WithoutId]: { table: K; file: string; key: readonly [Extract<keyof Row<K>, string>, ...Extract<keyof Row<K>, string>[]] } }[WithoutId];

/** The columns that, after created_at, order a table's rows deterministically. */
export function exportKey(t: ExportTable): readonly string[] {
  return "key" in t ? t.key : ["id"];
}

// Everything a customer owns, one CSV per table. Raw columns (ids included, so
// files can be joined), plus readable names next to the ids that need them.
// Every table here has organization_id, created_at and a key (the read orders by them).
export const EXPORT_TABLES: ReadonlyArray<ExportTable> = [
  { table: "leads", file: "leads.csv" },
  { table: "contacts", file: "contacts.csv" },
  { table: "contact_channels", file: "contact_channels.csv" },
  // CON-05: every company of a contact, with the role there; is_primary = the contact's company_id
  { table: "contact_companies", file: "contact_companies.csv" },
  // CON-06: relations between contacts, and the business's types of relation
  { table: "contact_relations", file: "contact_relations.csv" },
  { table: "contact_relation_types", file: "contact_relation_types.csv" },
  // CNS-01: the consent history of leads and contacts (rows of purged records are not readable, so not exported)
  { table: "consents", file: "consents.csv" },
  { table: "companies", file: "companies.csv" },
  { table: "deals", file: "deals.csv" },
  { table: "deal_contacts", file: "deal_contacts.csv", key: ["deal_id", "contact_id"] },
  // CON-03 follow-up
  { table: "deal_contact_roles", file: "deal_contact_roles.csv" },
  { table: "tasks", file: "tasks.csv" },
  { table: "activities", file: "activities.csv" },
  // TASK-08: the business's names of activity and task types (activity_type_id on activities and tasks)
  { table: "activity_types", file: "activity_types.csv" },
  { table: "meetings", file: "meetings.csv" },
  { table: "meeting_participants", file: "meeting_participants.csv" },
  // CAL-08
  { table: "meeting_types", file: "meeting_types.csv" },
  // CAL-10: the booking pages (token = the page's link: /f/book/<token>)
  { table: "booking_pages", file: "booking_pages.csv" },
  // SEG-01
  { table: "segments", file: "segments.csv" },
  { table: "segment_members", file: "segment_members.csv" },
  // BIZ-02: the business cards (token = the card's link: /f/card/<token>)
  { table: "business_cards", file: "business_cards.csv" },
  // BIZ-03: the QR codes (token = the code's link: /f/q/<token>); the daily scan counts are in schema app, not exported
  { table: "qr_codes", file: "qr_codes.csv" },
  // SPD-07: the site widgets (token = the widget's public script and form; its view counts are in schema app, not exported)
  { table: "site_widgets", file: "site_widgets.csv" },
  // TASK-06
  { table: "task_checklist_items", file: "task_checklist_items.csv" },
  { table: "checklist_templates", file: "checklist_templates.csv" },
  { table: "pipelines", file: "pipelines.csv" },
  { table: "stages", file: "stages.csv" },
  { table: "lead_statuses", file: "lead_statuses.csv" },
  { table: "lead_sources", file: "lead_sources.csv" },
  { table: "disqualify_reasons", file: "disqualify_reasons.csv" },
  { table: "deal_loss_reasons", file: "deal_loss_reasons.csv" },
  { table: "record_type_options", file: "record_types.csv" },
  { table: "tags", file: "tags.csv" },
  { table: "field_definitions", file: "custom_fields.csv" },
  // LEAD-06: where each lead custom field goes on conversion
  { table: "conversion_field_maps", file: "conversion_field_maps.csv" },
  { table: "teams", file: "teams.csv" },
  { table: "team_members", file: "team_members.csv", key: ["team_id", "user_id"] },
  { table: "whatsapp_templates", file: "whatsapp_templates.csv" },
  // GOL-01
  { table: "goals", file: "goals.csv" },
  // PRD-04
  { table: "product_categories", file: "product_categories.csv" },
  { table: "product_units", file: "product_units.csv" },
  // PRD-01
  { table: "products", file: "products.csv" },
  // PRD-06: the cost of each product (the full export is the owner's, who sees costs)
  { table: "product_costs", file: "product_costs.csv" },
  // PL-01
  { table: "price_lists", file: "price_lists.csv" },
  // PL-02
  { table: "price_list_lines", file: "price_list_lines.csv" },
  // DLI-01
  { table: "deal_lines", file: "deal_lines.csv" },
  // PRD-06 follow-up: the cost kept with each deal line (the owner sees costs)
  { table: "deal_line_costs", file: "deal_line_costs.csv" },
  // QUO-01, QUO-02
  { table: "quotes", file: "quotes.csv" },
  { table: "quote_lines", file: "quote_lines.csv" },
  // GAP-09
  { table: "quote_payment_steps", file: "quote_payment_steps.csv" },
  // QUO-09: the customer's decision on a quote (owners and admins read it)
  { table: "quote_decisions", file: "quote_decisions.csv" },
  // QUO-10: when the customer opened each quote
  { table: "quote_views", file: "quote_views.csv" },
  // ORD-01
  { table: "orders", file: "orders.csv" },
  { table: "order_lines", file: "order_lines.csv" },
  // ORD-04
  { table: "order_payment_steps", file: "order_payment_steps.csv" },
  // PAY-01
  { table: "payments", file: "payments.csv" },
  // ORD-05
  { table: "order_decisions", file: "order_decisions.csv" },
  // DOC-01
  { table: "accounting_documents", file: "accounting_documents.csv" },
  // QUO-04
  { table: "quote_templates", file: "quote_templates.csv" },
  { table: "quote_template_lines", file: "quote_template_lines.csv" },
  // QUO-05
  { table: "quote_designs", file: "quote_design.csv" },
  // FLD-10: the business's own words for contacts, leads and deals
  { table: "org_terms", file: "terms.csv" },
  { table: "org_modules", file: "modules.csv" },
  { table: "org_calendar_settings", file: "calendar_settings.csv" },
  // CAP-09
  { table: "member_leaves", file: "member_leaves.csv" },
  { table: "org_document_settings", file: "document_settings.csv" },
  { table: "org_bank_details", file: "bank_details.csv" },
  // CAP-10
  { table: "lead_response_settings", file: "response_settings.csv" },
  // QUO-03: the running number series of quotes and orders
  { table: "number_sequences", file: "number_sequences.csv" },
  // CAP-08
  { table: "lead_distribution_settings", file: "lead_distribution.csv" },
  { table: "lead_routing_rules", file: "lead_routing_rules.csv" },
  // DQL-01: the important fields per record type
  { table: "completeness_settings", file: "completeness_settings.csv" },
  // FLD-08: the card layout per record type
  { table: "card_layouts", file: "card_layouts.csv" },
  // LEAD-05: the lead score rules
  { table: "lead_score_rules", file: "lead_score_rules.csv" },
  { table: "files", file: "files.csv" },
];

// tables whose clients may not select every column: the columns the export reads (else "*")
export const EXPORT_COLUMNS: Partial<Record<ExportTableName, string>> = {
  // CNS-01: the address hash is not shown to anyone (column grants)
  consents:
    "id, organization_id, seq, lead_id, contact_id, subject_type, subject_id, channel, state, source, wording, method, copied_from, lift_method, lift_note, recorded_by, created_at",
};

// readable names added next to these id columns
export const LOOKUPS: Record<string, string> = {
  owner_id: "owner",
  created_by: "created_by_name",
  recorded_by: "recorded_by_name",
  user_id: "user",
  status_id: "status",
  source_id: "source",
  stage_id: "stage",
  pipeline_id: "pipeline",
  company_id: "company",
  contact_id: "contact",
  deal_id: "deal",
  // DEAL-11: the deal a follow-up continues
  previous_deal_id: "previous_deal",
  meeting_id: "meeting",
  team_id: "team",
  type_id: "type",
  // PRD-04: a subcategory's top category
  parent_id: "parent",
  // PRD-01
  category_id: "category",
  unit_id: "unit",
  // CON-08: a company's or contact's price list
  price_list_id: "price_list",
  // LEAD-04: a lead's requested product
  requested_product_id: "requested_product",
  // HEB-08: who stands in during an absence
  deputy_id: "deputy",
  // CON-03 follow-up: a contact's role on a deal, from the list (the old code keeps "role_name")
  role_id: "role_label",
  // CON-06: the other contact of a relation
  related_contact_id: "related_contact",
  // TASK-08: the business's type of an activity or a task
  activity_type_id: "activity_type",
};

export type ExportRow = Record<string, unknown>;

const OCCASION_NAMES = new Map<string, string>(OCCASIONS.map((o) => [o.key, o.name]));

// readable columns added next to these coded ones; `table` limits one to the table it was made for
const READABLE: Record<string, { header: string; get: (value: unknown, row: ExportRow) => string; table?: ExportTableName }> = {
  // the rest days of CAL-03; 0 = Sunday … 6 = Saturday
  rest_weekdays: {
    header: "rest_days",
    get: (value) => (Array.isArray(value) ? value.map((d) => WEEKDAYS_LONG[Number(d)] ?? String(d)).join("; ") : ""),
  },
  // a key the app no longer knows stays as it is
  rest_occasions: {
    header: "rest_occasion_names",
    get: (value) => (Array.isArray(value) ? value.map((k) => OCCASION_NAMES.get(String(k)) ?? String(k)).join("; ") : ""),
  },
  // CON-03: the contact's role in the deal; a code this version does not know stays empty
  role: { header: "role_name", table: "deal_contacts", get: (value) => dealContactRoleLabel(typeof value === "string" ? value : null) ?? "" },
  // CON-01: the type of a further phone or email (mobile, work…)
  label: {
    header: "label_name",
    table: "contact_channels",
    get: (value, row) =>
      row.kind === "phone" || row.kind === "email" ? (channelTypeLabel(row.kind, typeof value === "string" ? value : null) ?? "") : "",
  },
};

// tables whose rows are named by their name column
const NAMED_BY_NAME = new Set<string>([
  "lead_statuses", "lead_sources", "stages", "pipelines", "companies", "teams", "record_type_options", "product_categories", "product_units",
  "price_lists", "products", "deal_contact_roles", "contact_relation_types", "activity_types",
]);

/**
 * id -> readable name for the LOOKUPS columns: people from their profiles, and
 * the rows of the exported tables that other rows point to; plus tag names.
 */
export function exportNames(
  data: ReadonlyArray<{ table: ExportTableName; rows: ExportRow[] }>,
  profiles: ReadonlyArray<{ id: string; full_name: string | null; email: string | null }>,
): { names: Map<string, string>; tagNames: Map<string, string> } {
  const names = new Map<string, string>();
  for (const p of profiles) names.set(p.id, p.full_name?.trim() || p.email || "");
  const tagNames = new Map<string, string>();
  for (const t of data) {
    for (const r of t.rows) {
      const id = r.id as string | undefined;
      if (!id) continue;
      if (t.table === "tags") tagNames.set(id, String(r.name ?? ""));
      if (NAMED_BY_NAME.has(t.table)) names.set(id, String(r.name ?? ""));
      if (t.table === "contacts") names.set(id, String(r.full_name ?? r.email ?? ""));
      if (t.table === "meetings") names.set(id, String(r.title ?? ""));
      if (t.table === "deals") names.set(id, String(r.name ?? ""));
    }
  }
  return { names, tagNames };
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return csvText(typeof value === "object" ? JSON.stringify(value) : String(value));
}

/** One table as CSV for Excel: BOM, CRLF, a name column after each id in LOOKUPS, custom fields as custom:<key>. */
export function toCsv(rows: ExportRow[], names: Map<string, string>, tagNames: Map<string, string>, table?: ExportTableName): string {
  if (rows.length === 0) return "﻿";
  const customKeys = [...new Set(rows.flatMap((r) => (r.custom_fields && typeof r.custom_fields === "object" ? Object.keys(r.custom_fields as object) : [])))];
  const base = Object.keys(rows[0]).filter((k) => k !== "custom_fields");
  const columns: Array<{ header: string; get: (r: ExportRow) => unknown }> = [];
  for (const k of base) {
    columns.push({ header: k, get: (r) => r[k] });
    if (LOOKUPS[k]) columns.push({ header: LOOKUPS[k], get: (r) => (typeof r[k] === "string" ? (names.get(r[k] as string) ?? "") : "") });
    const readable = READABLE[k];
    if (readable && (!readable.table || readable.table === table)) columns.push({ header: readable.header, get: (r) => readable.get(r[k], r) });
    if (k === "tag_ids") columns.push({ header: "tags", get: (r) => ((r.tag_ids as string[] | null) ?? []).map((id) => tagNames.get(id) ?? id).join("; ") });
  }
  for (const k of customKeys) columns.push({ header: `custom:${k}`, get: (r) => ((r.custom_fields as Record<string, Json> | null) ?? {})[k] });
  const lines = [columns.map((c) => cell(c.header)).join(","), ...rows.map((r) => columns.map((c) => cell(c.get(r))).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

export const EXPORT_README = `ייצוא מלא של נתוני העסק.

כל קובץ CSV הוא טבלה אחת, ונפתח ב-Excel עם עברית תקינה.
עמודות id מקשרות בין הקבצים (למשל company_id באנשי קשר הוא id בקובץ companies.csv).
ליד כל מזהה של משתמש, סטטוס, מקור, שלב, חברה, איש קשר, עסקה או פגישה מופיעה גם עמודה עם השם.
עמודות custom:... הן השדות המותאמים. רשומות עם deleted_at נמצאות בסל המחזור.
סכומים (amount_agorot) הם באגורות: מחלקים ב-100 לקבלת שקלים.
הפגישות נמצאות ב-meetings.csv (owner הוא מי שקבע את הפגישה), והמשתתפים בכל פגישה ב-meeting_participants.csv.
ימי המנוחה של העסק נמצאים ב-calendar_settings.csv: rest_weekdays הם ימי השבוע (0 = ראשון עד 6 = שבת), holidays_rest אומר אם החגים הם ימי מנוחה, holiday_eves_rest אם ערבי החג, ו-rest_occasions מועדים נוספים שבחרתם. אם הקובץ ריק, ההגדרות הן ברירת המחדל: שישי ושבת וחגים. working_hours הן שעות העבודה של העסק לפי יום (sun עד sat, כל יום רשימה של טווחים start עד end); ריק = בלי הגבלת שעות.
החופשות של העובדים נמצאות ב-member_leaves.csv: user הוא העובד, starts_on ו-ends_on הם הימים הראשון והאחרון של החופשה, kind הוא סוג ההיעדרות (reserve = במילואים, vacation = בחופשה, ריק = היעדרות אחרת), ו-deputy הוא ממלא המקום.
היעדים נמצאים ב-goals.csv: scope הוא user (חבר צוות), team (צוות) או org (כל העסק); period הוא month, quarter או year מ-period_start; metric הוא won_amount (הכנסה שנסגרה, target באגורות), won_deals, leads_handled או meetings_held.
המעמד של העסק במע"מ נמצא ב-document_settings.csv: vat_status הוא licensed (עוסק מורשה או חברה בע"מ), exempt (עוסק פטור), nonprofit (עמותה או מלכ"ר) או other (מעמד אחר, ששמו ב-vat_status_other, ו-other_charges_vat אומר אם הוא גובה מע"מ). legal_form היא צורת ההתאגדות. באותו קובץ פרטי העסק שמופיעים במסמכים: legal_name (שם רשמי), tax_id (מספר עוסק או ח.פ., 9 ספרות), address_line, city ו-postal_code (כתובת), phone ו-email (פרטי קשר במסמכים, והאימייל גם בהזמנות ליומן). פרטי הבנק להעברה נמצאים ב-bank_details.csv: bank_name, bank_branch, bank_account ו-bank_account_name (רק בעלים ומנהלי מערכת רואים אותם במערכת).
קטגוריות המוצרים נמצאות ב-product_categories.csv (parent_id היא הקטגוריה הראשית של תת-קטגוריה), ויחידות המידה ב-product_units.csv. המוצרים נמצאים ב-products.csv: price_agorot הוא המחיר באגורות כפי שהוקלד, ו-price_includes_vat אומר אם הוא כולל מע"מ; archived_at מסמן מוצר בארכיון. העלות של כל מוצר נמצאת ב-product_costs.csv: product_id הוא המוצר ו-cost_agorot העלות ליחידה באגורות.
המחירונים נמצאים ב-price_lists.csv: valid_from ו-valid_to הם התאריכים שבהם המחירון בתוקף (ריק = בלי הגבלה), is_active אומר אם הוא פעיל, ו-prices_include_vat אומר אם המחירים הקבועים במחירון כוללים מע"מ. מחירון ברירת המחדל הוא המחיר שבכל מוצר. המחירים שבכל מחירון נמצאים ב-price_list_lines.csv: min_quantity היא הכמות שממנה השורה חלה (0 = כל כמות), ובכל שורה יש מחיר קבוע באגורות (price_agorot; price_includes_vat בשורה מעתיק את ההגדרה של המחירון) או הנחה מהמחיר של המוצר (discount_bp, ב-1/100 של אחוז: 1000 = 10%).
פרטי החיוב של חברות ואנשי קשר נמצאים בעמודות של companies.csv ושל contacts.csv: billing_name (שם לחשבונית), billing_tax_id (באנשי קשר: מספר עוסק או ת"ז; בחברה המספר הוא tax_id), billing_address ו-shipping_address (כתובת לחיוב ולמשלוח), billing_email (אימייל לחשבוניות), payment_terms (immediate = מיידי, net = מספר ימים מתאריך המסמך, eom = שוטף + מספר ימים) עם payment_days, ו-price_list_id עם שם המחירון ב-price_list.
המוצר שליד ביקש נמצא ב-leads.csv: requested_product_id ושם המוצר ב-requested_product.
טלפונים ומיילים נוספים של אנשי קשר נמצאים ב-contact_channels.csv (kind הוא phone או email, ו-label_name הוא הסוג: נייד, עבודה וכו'). הטלפון והמייל הראשיים נמצאים ב-contacts.csv.
כל החברות של כל איש קשר נמצאות ב-contact_companies.csv, עם התפקיד שלו באותה חברה (title); is_primary מסמן את החברה הראשית, שהיא גם company_id ב-contacts.csv.
הקשרים בין אנשי קשר נמצאים ב-contact_relations.csv: contact_id הוא הצד הראשון (או lead_id, כשליד הפנה את איש הקשר), related_contact_id הצד השני, ו-type_id סוג הקשר. סוגי הקשר נמצאים ב-contact_relation_types.csv: name נקרא מהצד הראשון ("הורה של"), ו-reverse_name מהצד השני ("ילד/ה של"; ריק = אותו דבר משני הצדדים).
אנשי הקשר בכל עסקה נמצאים ב-deal_contacts.csv, עם התפקיד שלהם בעסקה (role_name).
שורות המוצרים בעסקאות נמצאות ב-deal_lines.csv: deal_id היא העסקה, product_id המוצר (ריק = שורה חופשית), description התיאור, quantity הכמות, unit_price_agorot מחיר היחידה באגורות, ההנחה בשורה ב-discount_bp (1/100 של אחוז) או ב-discount_agorot, ו-total_agorot סכום השורה אחרי ההנחה. price_includes_vat אומר אם המחירים בשורה כוללים מע"מ, ו-price_list_name הוא המחירון שממנו נלקח המחיר. העלות של כל שורה נמצאת ב-deal_line_costs.csv: deal_line_id היא השורה ו-cost_agorot העלות ליחידה באגורות, כפי שנשמרה כשהשורה נוצרה.
הצעות המחיר נמצאות ב-quotes.csv: title הכותרת, status המצב (draft = טיוטה), deal_id, contact_id ו-company_id הלקוח, quote_date התאריך ו-valid_until התוקף. הסכומים באגורות: subtotal_agorot (השורות), discount_total_agorot (הנחה על ההצעה), net_total_agorot (לפני מע"מ), vat_agorot ו-total_agorot; vat_rate_bp הוא שיעור המע"מ ב-1/100 של אחוז, ו-no_vat_reason סיבה להצעה בלי מע"מ (eilat = אילת, abroad = לקוח בחו"ל, other = אחר, עם no_vat_note). השורות נמצאות ב-quote_lines.csv: quote_id ההצעה, kind הוא item (שורה) או group (כותרת של קבוצה), name ו-description, quantity, unit_price_agorot, ההנחה, total_agorot, ו-is_optional / optional_selected לשורת רשות ואם נבחרה. לוח התשלומים של הצעה נמצא ב-quote_payment_steps.csv: quote_id ההצעה, name שם התשלום, percent_bp האחוז ב-1/100 של אחוז (10000 = 100%), due_date המועד ו-milestone אבן הדרך. ההחלטות של הלקוחות על הצעות נמצאות ב-quote_decisions.csv: quote_id ההצעה, decision אושרה (accepted) או נדחתה (rejected), decided_at המועד, signer_name ו-signer_id_number החותם, signature_kind ציור (drawn) או שם מוקלד (typed) עם signature_image תמונת החתימה, wording_version נוסח תיבת האישור, content_sha256 טביעת הגרסה שנחתמה, ip ו-user_agent הכתובת והדפדפן, ו-decline_reason סיבת הדחייה. הצפיות של הלקוח בכל הצעה נמצאות ב-quote_views.csv: quote_id ההצעה, first_viewed_at הצפייה הראשונה, last_viewed_at הצפייה האחרונה ו-view_count מספר הצפיות.
ההזמנות נמצאות ב-orders.csv: number_display המספר (ריק = טיוטה), status המצב (draft = טיוטה, new = חדשה, in_progress = בטיפול, partly_delivered = סופקה חלקית, delivered = סופקה, cancelled = בוטלה), source המקור (manual = ידנית, quote = מהצעת מחיר, quote_id ההצעה; deal = מעסקה), deal_id, contact_id ו-company_id הלקוח, delivery_contact_id איש הקשר למשלוח, order_date התאריך, delivery_date מועד האספקה ו-shipping_address כתובת המשלוח. הסכומים באגורות כמו בהצעות. השורות נמצאות ב-order_lines.csv: order_id ההזמנה, name ו-description, quantity, unit_price_agorot, ההנחה, billing (one_time = חד-פעמי, monthly = חודשי, quarterly = רבעוני, yearly = שנתי) ו-total_agorot. לוח התשלומים של הזמנה נמצא ב-order_payment_steps.csv: order_id ההזמנה, name שם התשלום, percent_bp האחוז ב-1/100 של אחוז (10000 = 100%), due_date המועד ו-milestone אבן הדרך. התשובות של הלקוחות בקישור להזמנה נמצאות ב-order_decisions.csv: order_id ההזמנה, decision אושרה (accepted) או נדחתה (rejected), decided_at המועד, ופרטי החותם כמו בהצעות. המסמכים החשבונאיים שהופקו מחוץ למערכת ונרשמו נמצאים ב-accounting_documents.csv: deal_id או contact_id הרשומה, doc_type הסוג (tax_invoice = חשבונית מס, tax_invoice_receipt = חשבונית מס/קבלה, receipt = קבלה, credit_invoice = חשבונית זיכוי, proforma = חשבונית עסקה), number המספר, doc_date התאריך, amount_agorot הסכום באגורות, ו-status (active = רשום, cancelled = בוטל, עם cancel_reason). התשלומים שהתקבלו נמצאים ב-payments.csv: deal_id או contact_id הרשומה, amount_agorot הסכום באגורות, paid_on התאריך, method האמצעי (credit = אשראי, עם installments מספר התשלומים; transfer = העברה בנקאית, cash = מזומן, cheque = צ'ק, bit_paybox = Bit או PayBox, standing_order = הוראת קבע, other = אחר), reference האסמכתא, note ההערה, ו-status המצב (recorded = נרשם, confirmed = אושר, failed = נכשל, refunded = הוחזר, cancelled = בוטל, עם cancel_reason הסיבה). תשלום לא נמחק: הוא מבוטל, ולא נספר בסכומים.
תבניות ההצעה נמצאות ב-quote_templates.csv (name השם, notes ו-terms, ו-prices_include_vat אם המחירים בתבנית כוללים מע"מ), והשורות שלהן ב-quote_template_lines.csv: template_id התבנית, ושאר העמודות כמו בשורות ההצעה. unit_price_agorot ריק בשורת מוצר פירושו שהמחיר נלקח מהקטלוג כשמשתמשים בתבנית.
חלוקת הלידים נמצאת ב-lead_distribution.csv: method הוא round_robin (סבב), weighted (לפי משקל) או load (לפי עומס פתוח), ו-weights הם המשקלים של העובדים (מזהה משתמש ומספר מ-1 עד 10; מי שלא מופיע שוקל 1). כללי החלוקה נמצאים ב-lead_routing_rules.csv: ליד מהמקור source_id, עם המוצר product_id, בשפה locale ו/או עם הערך field_value בשדה field_key (כל מה שמולא בכלל צריך להתאים) נשלח לצוות team_id או לאדם user_id, לפי הסדר position, ורק כללים עם is_active.
חברי כל צוות נמצאים ב-team_members.csv (is_manager אומר אם הוא מנהל הצוות), ותבניות הודעות הוואטסאפ ב-whatsapp_templates.csv.
הקבצים שצורפו לרשומות נמצאים בתיקייה files, בשם <id>-<שם הקובץ>, ו-files.csv אומר לאיזו רשומה כל אחד שייך.
`;
