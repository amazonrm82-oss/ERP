import { z } from "zod";

// PRV-03: removing a person from everywhere in one action (public.privacy_erase_person; the window's preview is
// public.privacy_erase_preview). Shapes and wording shared by the server actions and the window.

export type EraseKind = "lead" | "contact";
export const ERASE_TABLE: Record<EraseKind, "leads" | "contacts"> = { lead: "leads", contact: "contacts" };
export type EraseTable = "leads" | "contacts";

const person = z.object({ id: z.string(), name: z.string().nullable(), in_bin: z.boolean() });
const match = z.object({
  type: z.enum(["leads", "contacts"]),
  id: z.string(),
  via: z.enum(["phone", "email"]),
  shared: z.number(),
  family: z.string(),
  relatives: z.number(),
  preselect: z.boolean(),
  name: z.string().nullable(),
});
const deal = z.object({ id: z.string(), name: z.string(), must_rename: z.boolean(), suggested: z.string() });
const counts = z.object({
  leads: z.number(),
  contacts: z.number(),
  channels: z.number(),
  files: z.number(),
  inquiries: z.number(),
  meetings: z.number(),
  activities: z.number(),
});
export const previewSchema = z.object({
  people: z.object({ leads: z.array(person), contacts: z.array(person) }),
  matches: z.array(match),
  matches_truncated: z.boolean(),
  counts,
  deals: z.array(deal),
});

export type ErasePerson = { id: string; name: string; inBin: boolean };
export type EraseMatch = {
  type: EraseTable;
  id: string;
  via: "phone" | "email";
  name: string;
  /** most records outside the person's set that hold the address it was found by */
  shared: number;
  /** one key per conversion family: the window ticks a family as one */
  family: string;
  /** conversion relatives that ticking it would also take, beyond the offered records */
  relatives: number;
  preselect: boolean;
};
export type EraseDeal = { id: string; name: string; mustRename: boolean; suggested: string };
export type EraseCounts = z.infer<typeof counts>;
export type ErasePreview = {
  leads: ErasePerson[];
  contacts: ErasePerson[];
  matches: EraseMatch[];
  /** more than 200 records share a detail; only the first 200 are offered */
  matchesTruncated: boolean;
  counts: EraseCounts;
  deals: EraseDeal[];
};

const NO_NAME = "ללא שם";

export function previewFrom(raw: unknown): ErasePreview | null {
  const parsed = previewSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const named = (n: string | null) => n?.trim() || NO_NAME;
  return {
    leads: p.people.leads.map((r) => ({ id: r.id, name: named(r.name), inBin: r.in_bin })),
    contacts: p.people.contacts.map((r) => ({ id: r.id, name: named(r.name), inBin: r.in_bin })),
    matches: p.matches.map((m) => ({
      type: m.type,
      id: m.id,
      via: m.via,
      name: named(m.name),
      shared: m.shared,
      family: m.family,
      relatives: m.relatives,
      preselect: m.preselect,
    })),
    matchesTruncated: p.matches_truncated,
    counts: p.counts,
    deals: p.deals.map((d) => ({ id: d.id, name: d.name, mustRename: d.must_rename, suggested: d.suggested })),
  };
}

export const MATCHES_TRUNCATED = "יש עוד רשומות עם אותו פרט; אפשר למחוק אותן בנפרד.";

/** The line under an offered record: how it was found, why it is not ticked from the start, and what goes with it. */
export function matchHint(m: Pick<EraseMatch, "via" | "shared" | "relatives">, together: string[] = []): string {
  const parts = [m.via === "phone" ? "אותו טלפון" : "אותו אימייל"];
  if (together.length > 0) parts.push(`נמחק יחד עם ${together.join(", ")}`);
  if (m.shared > 2) parts.push(`משותף ל-${m.shared} רשומות`);
  if (m.relatives > 0) parts.push(m.relatives === 1 ? "יחד איתה תימחק עוד רשומה קשורה אחת" : `יחד איתה יימחקו עוד ${m.relatives} רשומות קשורות`);
  return parts.join(" · ");
}

/** The offered records of the same conversion family as `m`, apart from it (they are ticked and unticked together). */
export function familyOf(matches: EraseMatch[], m: Pick<EraseMatch, "type" | "id" | "family">): EraseMatch[] {
  return matches.filter((o) => o.family === m.family && !(o.type === m.type && o.id === m.id));
}

/** The offered records the window does not tick from the start. */
export function notPreselected(matches: EraseMatch[], key: (m: EraseMatch) => string): Set<string> {
  return new Set(matches.filter((m) => !m.preselect).map(key));
}

export const resultSchema = z.object({ leads: z.number(), contacts: z.number(), paused: z.boolean() }).passthrough();

/** The name typed to confirm must match one of the person's records (spaces and case aside). */
export function confirmsName(typed: string, preview: Pick<ErasePreview, "leads" | "contacts">): boolean {
  const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase("he");
  const want = norm(typed);
  if (want.length < 2) return false;
  return [...preview.leads, ...preview.contacts].some((r) => r.name !== NO_NAME && norm(r.name) === want);
}

/** What the window lists as going, by type, in the owner's words; zero counts are left out. */
export function countLines(c: EraseCounts): string[] {
  const lines: Array<[number, string, string]> = [
    [c.leads, "ליד אחד", "לידים"],
    [c.contacts, "איש קשר אחד", "אנשי קשר"],
    [c.channels, "טלפון או אימייל נוסף אחד", "טלפונים ואימיילים נוספים"],
    [c.files, "קובץ אחד", "קבצים"],
    [c.inquiries, "פנייה אחת מטופס", "פניות מטפסים"],
    [c.activities, "רשומה אחת בציר הזמן", "רשומות בציר הזמן"],
  ];
  const out = lines.filter(([n]) => n > 0).map(([n, one, many]) => (n === 1 ? one : `${n} ${many}`));
  if (c.meetings > 0) out.push(c.meetings === 1 ? "פגישה אחת נשארת בלי פרטי האדם" : `${c.meetings} פגישות נשארות בלי פרטי האדם`);
  return out;
}

export const REASON_MAX = 500;
export const DEAL_NAME_MAX = 200;
export const ERASE_NEEDS_SECOND_STEP = "כדי למחוק אדם מכל המקומות צריך להיכנס עם אימות דו-שלבי. התנתקו, התחברו שוב והזינו את הקוד.";
export const ERASE_CHANGED = "הרשומות השתנו בזמן המחיקה, נסו שוב.";
export const ERASE_NOT_READY = "הפעולה עוד לא זמינה בעסק. נסו שוב מאוחר יותר.";
export const ERASE_DEAL_NAME = "לעסקה שנשארת צריך שם חדש שלא כולל את שם האדם.";
export const ERASE_REASON = "יש לכתוב סיבה למחיקה (עד 500 תווים).";
export const ERASE_EXTRA_MAX = "נבחרו יותר מדי רשומות עם אותו טלפון או אימייל (עד 200).";
export const ERASE_EXTRA = "רשימת הרשומות עם אותו טלפון או אימייל השתנתה. פתחו את החלון שוב.";
