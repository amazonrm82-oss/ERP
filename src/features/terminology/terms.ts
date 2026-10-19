// FLD-10 (owner, 18 October 2026, answer (א)): a business may call its contacts, leads and deals by its own words, from a
// ready list only (free text breaks gender and plural on every screen). Every form is written here by hand. The keys
// mirror the check constraints of public.org_terms (migration org_terms; a unit test reads it). No choice = today's words.

export type Gender = "m" | "f";

export type TermForms = {
  /** "ליד", "פנייה" */
  singular: string;
  /** "לידים", "פניות" */
  plural: string;
  gender: Gender;
  /** "ליד חדש", "פנייה חדשה" */
  newOne: string;
  /** "הליד", "הפנייה" */
  theSingular: string;
  /** "הלידים", "הפניות" */
  thePlural: string;
};

const forms = (singular: string, plural: string, gender: Gender, theSingular: string, thePlural: string): TermForms => ({
  singular,
  plural,
  gender,
  newOne: `${singular} ${gender === "m" ? "חדש" : "חדשה"}`,
  theSingular,
  thePlural,
});

export const CONTACT_TERMS = {
  contact: forms("איש קשר", "אנשי קשר", "m", "איש הקשר", "אנשי הקשר"),
  customer: forms("לקוח", "לקוחות", "m", "הלקוח", "הלקוחות"),
  patient: forms("מטופל", "מטופלים", "m", "המטופל", "המטופלים"),
  student: forms("תלמיד", "תלמידים", "m", "התלמיד", "התלמידים"),
  member: forms("חבר", "חברים", "m", "החבר", "החברים"),
} as const;

export const LEAD_TERMS = {
  lead: forms("ליד", "לידים", "m", "הליד", "הלידים"),
  inquiry: forms("פנייה", "פניות", "f", "הפנייה", "הפניות"),
  prospect: forms("מתעניין", "מתעניינים", "m", "המתעניין", "המתעניינים"),
} as const;

export const DEAL_TERMS = {
  deal: forms("עסקה", "עסקאות", "f", "העסקה", "העסקאות"),
  opportunity: forms("הזדמנות", "הזדמנויות", "f", "ההזדמנות", "ההזדמנויות"),
  case: forms("תיק", "תיקים", "m", "התיק", "התיקים"),
} as const;

export type ContactTerm = keyof typeof CONTACT_TERMS;
export type LeadTerm = keyof typeof LEAD_TERMS;
export type DealTerm = keyof typeof DEAL_TERMS;

/** The business's words, resolved: what every screen asks for. */
export type OrgTerms = { contact: TermForms; lead: TermForms; deal: TermForms };

/** The stored keys (null = today's word). */
export type OrgTermKeys = { contact: ContactTerm | null; lead: LeadTerm | null; deal: DealTerm | null };

export const DEFAULT_TERM_KEYS: OrgTermKeys = { contact: null, lead: null, deal: null };

function pick<T extends Record<string, TermForms>>(list: T, key: string | null | undefined, fallback: keyof T): TermForms {
  return key && key in list ? list[key as keyof T] : list[fallback];
}

/** Keys from the database row (unknown or missing = today's word). */
export function termKeys(row: { contact_term?: string | null; lead_term?: string | null; deal_term?: string | null } | null): OrgTermKeys {
  const ok = <T extends string>(list: Record<string, unknown>, value: string | null | undefined) => (value && value in list ? (value as T) : null);
  return {
    contact: ok<ContactTerm>(CONTACT_TERMS, row?.contact_term),
    lead: ok<LeadTerm>(LEAD_TERMS, row?.lead_term),
    deal: ok<DealTerm>(DEAL_TERMS, row?.deal_term),
  };
}

export function resolveTerms(keys: OrgTermKeys): OrgTerms {
  return {
    contact: pick(CONTACT_TERMS, keys.contact, "contact"),
    lead: pick(LEAD_TERMS, keys.lead, "lead"),
    deal: pick(DEAL_TERMS, keys.deal, "deal"),
  };
}

/** Today's words, for code that has no business at hand. */
export const DEFAULT_TERMS: OrgTerms = resolveTerms(DEFAULT_TERM_KEYS);

/** The masculine or feminine form of a word that agrees with the term ("שמתאימים" / "שמתאימות"). */
export function byGender(term: TermForms, masculine: string, feminine: string): string {
  return term.gender === "m" ? masculine : feminine;
}

/** "לידים שמחכים" / "פניות שמחכות": the verb agrees with the word's gender. */
export function waitingPlural(term: TermForms): string {
  return `${term.plural} ${term.gender === "m" ? "שמחכים" : "שמחכות"}`;
}

/** "אין עדיין לידים" / "אין עדיין פניות". */
export function noneYet(term: TermForms): string {
  return `אין עדיין ${term.plural}`;
}
