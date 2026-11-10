import { strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";

import { printsTimelineEntry } from "@/features/print/print";

// PRV-02: everything about one person in one ZIP. Pure helpers (no database), shared by the route and the unit test.

export type PersonKind = "lead" | "contact";
export type Row = Record<string, unknown>;

/** The records that are this person: the lead(s), the contact made from them, and the deals linked to them. */
export type PersonIds = { lead: string[]; contact: string[]; deal: string[] };

/** A stored file to put in the ZIP: its id and name, where it is, and the size its row declares. */
export type StoredFile = { id: string; name: string; path: string; declaredBytes: number };

// the stored files go into the ZIP up to this total, counted by their real length; past it, README.txt lists them
export const FILES_MAX_BYTES = 100 * 1024 * 1024;

/** One PostgREST `or` filter for rows linked to any of the person's records; null when there is none to look for. */
export function personLinkFilter(ids: PersonIds): string | null {
  const parts: string[] = [];
  if (ids.lead.length) parts.push(`lead_id.in.(${ids.lead.join(",")})`);
  if (ids.contact.length) parts.push(`contact_id.in.(${ids.contact.join(",")})`);
  if (ids.deal.length) parts.push(`deal_id.in.(${ids.deal.join(",")})`);
  return parts.length ? parts.join(",") : null;
}

/** Ids without repeats or empty values, in first-seen order. */
export function uniqueIds(values: Array<unknown>): string[] {
  const seen = new Set<string>();
  for (const v of values) if (typeof v === "string" && v) seen.add(v);
  return [...seen];
}

/**
 * Someone else's private note never leaves the system in an export, even for an admin who may read it on screen: the
 * same rule as printing (`printsTimelineEntry`). The files attached to such a note go with it.
 */
export function withoutOthersPrivate(activities: Row[], files: Row[], userId: string): { activities: Row[]; files: Row[] } {
  const hidden = new Set<string>();
  const kept = activities.filter((a) => {
    const keep = printsTimelineEntry({ isPrivate: a.is_private === true, createdBy: typeof a.created_by === "string" ? a.created_by : null }, userId);
    if (!keep && typeof a.id === "string") hidden.add(a.id);
    return keep;
  });
  return { activities: kept, files: files.filter((f) => !(typeof f.activity_id === "string" && hidden.has(f.activity_id))) };
}

/** A file name that is safe inside the ZIP on every system, prefixed by the file's id so two files never clash. */
export function zipFileName(id: string, name: string): string {
  const clean =
    [...name]
      .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? "_" : ch))
      .join("")
      .trim() || "file";
  return `files/${id}-${clean.slice(0, 150)}`;
}

/** How many rows of data the export holds (every array in the sections, lookups left out). */
export function countRows(sections: Record<string, unknown>): number {
  let rows = 0;
  for (const [key, value] of Object.entries(sections)) {
    if (key === "lookups") continue;
    if (Array.isArray(value)) rows += value.length;
  }
  return rows;
}

export const PERSON_EXPORT_README = `ייצוא כל המידע על אדם אחד

בקובץ person.json נמצא כל מה שהעסק שומר על האדם, כפי שמי שהוריד את הקובץ רשאי לראות:
- people: הליד ואיש הקשר (כולל רשומות שנוצרו מהליד בהמרה)
- deals, deal_contacts: העסקאות שקשורות אליו
- contact_channels, contact_companies, contact_relations: טלפונים ואימיילים נוספים, חברות וקשרים
- activities: ציר הזמן (שיחות, הערות, הודעות)
- tasks, meetings: משימות ופגישות
- files: רשימת הקבצים; הקבצים עצמם בתיקייה files
- quotes, quote_lines: הצעות מחיר
- quote_decisions: אישור או דחייה של הצעת מחיר: שם החותם, מספר זהות, החתימה, כתובת IP, הדפדפן וסיבת הדחייה
- quote_views: מתי הצעות המחיר נצפו וכמה פעמים
- quote_payment_steps: לוח התשלומים של הצעות המחיר
- orders, order_lines: ההזמנות (כלקוח, כאיש הקשר למשלוח או בעסקאות) והשורות שלהן
- order_payment_steps: לוח התשלומים של ההזמנות
- payments: תשלומים שהתקבלו ונרשמו על איש הקשר או העסקאות
- payment_refunds: ההחזרים של התשלומים האלה
- punch_cards, punch_card_uses: הכרטיסיות של איש הקשר והכניסות שנוצלו בהן (כרטיסייה שלקוח אחר שילם עליה מסומנת "נפתחה ממסמך של לקוח אחר" בשדה opened_from); punch_cards_held_before: כרטיסיות שהיו שלו והועברו לאחר, עם התקופה שבה היו שלו והכניסות שנוצלו בה; punch_cards_paid: כרטיסיות שהוא שילם עליהן ושרשומות על מקבל שירות אחר (פרטי הקנייה בלבד)
- customer_holds: סימוני "לא למכור עד הסדרת חוב" על איש הקשר
- order_decisions: אישור או דחייה של הזמנה בקישור: שם החותם, מספר זהות, החתימה, כתובת IP, הדפדפן וסיבת הדחייה
- accounting_documents: מסמכים חשבונאיים (חשבוניות וקבלות) שהופקו מחוץ למערכת ונרשמו על איש הקשר או העסקאות
- accounting_document_lines: השורות של המסמכים החשבונאיים
- payment_promises: הבטחות תשלום שנרשמו על איש הקשר או על המסמכים שלו, עם הערת הגבייה
- privacy_requests: בקשות פרטיות שקשורות לליד או לאיש הקשר
- deal_lines: השורות (מוצרים ושירותים) של העסקאות
- task_checklist_items: השלבים של המשימות
- messages: יומן ההודעות שנשלחו לליד או לאיש הקשר או התקבלו מהם (ערוץ, סטטוס וזמנים, בלי תוכן)
- segment_members: הסגמנטים (רשימות ידניות) שהאדם הוכנס אליהם
- consents: הסכמות לדיוור והסרות
- form_submissions: פניות מטפסים
- lookups: שמות של סטטוסים, מקורות, שלבים, סגמנטים, משתמשים ושדות, כדי לקרוא את המזהים

הערות פרטיות של אחרים והקבצים שלהן, ורשומות שאין לך הרשאה לראות, לא נכללות.
`;

/**
 * The tables of the full export (EXPORT_TABLES) a person's export carries, each as its own section of person.json
 * (leads and contacts under `people`). A table of the full export that reaches a person (a lead, contact or deal id,
 * or a document, payment, quote, order, task, meeting or promise of theirs) is either here or in
 * PERSON_EXPORT_LEFT_OUT with the reason (unit test person-export-tables).
 */
export const PERSON_EXPORT_TABLES = [
  "leads",
  "contacts",
  "deals",
  "deal_contacts",
  "deal_lines",
  "contact_channels",
  "contact_companies",
  "contact_relations",
  "activities",
  "tasks",
  "task_checklist_items",
  "meetings",
  "files",
  "quotes",
  "quote_lines",
  "quote_decisions",
  "quote_views",
  "quote_payment_steps",
  "orders",
  "order_lines",
  "order_payment_steps",
  "order_decisions",
  "payments",
  "payment_refunds",
  "punch_cards",
  "punch_card_uses",
  "customer_holds",
  "payment_promises",
  "accounting_documents",
  "accounting_document_lines",
  "privacy_requests",
  "messages",
  "segment_members",
  "consents",
  "form_submissions",
] as const;

/** Tables of the full export that reach a person but stay out of the person's export, and why. */
export const PERSON_EXPORT_LEFT_OUT: Readonly<Record<string, string>> = {
  meeting_participants: "the staff members invited to a meeting (user ids), not the person",
  payment_promise_documents: "ids only: which open documents a customer promise covered; the promises and documents are in",
  payment_allocations: "ids and amounts between payments and documents; the payments and documents are in",
  opening_credit_allocations: "ids and amounts of credit offsets against documents; the documents are in",
  message_templates: "the business's shared message texts (MSG-02); not about any person",
  document_templates: "the business's document texts (SGN-01); not about any person, nothing filled is stored",
};

/** README.txt, with the files that were left out (over the size cap, or not readable). */
export function personExportReadme(skipped: string[]): string {
  return skipped.length
    ? `${PERSON_EXPORT_README}\nלא נכנסו לקובץ הזה ${skipped.length} קבצים (הגודל הכולל עובר 100 MB, או שהקובץ לא נמצא). אפשר להוריד אותם מהרשומה עצמה:\n${skipped.map((s) => `- ${s}`).join("\n")}\n`
    : PERSON_EXPORT_README;
}

/**
 * The ZIP as a stream: person.json, then one stored file per pull (read only when its turn comes, so at most one
 * file is held at a time), then README.txt. The cap counts the bytes really read, never the declared sizes.
 */
export function personZipStream(
  data: Row,
  files: StoredFile[],
  read: (path: string) => Promise<Uint8Array | null>,
  capBytes = FILES_MAX_BYTES,
): ReadableStream<Uint8Array> {
  let zip: Zip;
  let next = 0;
  let total = 0;
  const skipped: string[] = [];
  const add = (name: string, bytes: Uint8Array, compress: boolean) => {
    const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    zip.add(entry);
    entry.push(bytes, true);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((error, chunk, final) => {
        if (error) {
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
        if (final) controller.close();
      });
      add("person.json", strToU8(JSON.stringify(data, null, 2)), true);
    },
    async pull() {
      // one file per pull, skipping those left out, so the reader's pace decides how much is read ahead
      while (next < files.length) {
        const f = files[next++];
        // a declared size alone already past the cap: not worth reading
        if (total + Math.max(0, f.declaredBytes) > capBytes) {
          skipped.push(f.name);
          continue;
        }
        let bytes: Uint8Array | null = null;
        try {
          bytes = await read(f.path);
        } catch {
          bytes = null;
        }
        if (!bytes || total + bytes.length > capBytes) {
          skipped.push(f.name);
          continue;
        }
        total += bytes.length;
        // stored files are mostly compressed already (PDF, images, Office); passed through as they are
        add(zipFileName(f.id, f.name), bytes, false);
        return;
      }
      add("README.txt", strToU8(personExportReadme(skipped)), true);
      zip.end();
    },
  });
}
