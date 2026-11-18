// WEB-05 (owner (418) ב): the fixed texts of the two service emails to a new sign-up (welcome, the trial is about to end).
// Pure. Service texts only (no tips, no offers); the business cannot edit them. Wording of owner (443) ב; still a DRAFT
// until the language editor goes over it (SIGNUP_EMAIL_WORDING names the version).

import { SUPPORT_PHONE } from "@/lib/support-phone";

export const SIGNUP_EMAIL_WORDING = "signup-draft-2";

export const SIGNUP_EMAIL_KINDS = ["welcome", "trial_ending"] as const;
export type SignupEmailKind = (typeof SIGNUP_EMAIL_KINDS)[number];

/** The word the composer sends instead of a business name that holds a link, an "@" or a "://" (USR-09's rule). */
export const NEUTRAL_BUSINESS_NAME = "העסק";

/** The absolute links into the app (the handler builds them from the site's address and the business). */
export type SignupEmailLinks = {
  /** the business's home (welcome) */
  business: string;
  /** the plan screen (trial_ending) */
  plan: string;
  /** welcome's three first steps: users, the web forms screen, the import */
  users: string;
  intake: string;
  imports: string;
};

export type SignupEmailInput = {
  kind: SignupEmailKind;
  /** the owner's first name as the composer answered it; null = "שלום," */
  firstName: string | null;
  businessName: string;
  /** the trial's last day in the business's zone (YYYY-MM-DD); required for trial_ending; null = no trial line in welcome */
  trialEndDay: string | null;
  links: SignupEmailLinks;
};

export type SignupEmail = { subject: string; text: string; links: string[] };

// control characters, bidi and invisible ones
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

function cleanName(name: string): string {
  const flat = name.replace(new RegExp(INVISIBLE.source, "g"), " ").replace(/\s+/g, " ").trim();
  return (flat || NEUTRAL_BUSINESS_NAME).slice(0, 80);
}

/** The first name as it may be written in the greeting; null for anything that is not a plain short name. */
export function greetingName(name: string | null): string | null {
  if (typeof name !== "string") return null;
  const word = name.trim().split(/\s+/)[0] ?? "";
  if (!word || word.length > 40 || INVISIBLE.test(word) || word.includes("@") || word.includes("://") || /^www\./i.test(word)) return null;
  return word;
}

function realDay(day: string | null): Date | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return date;
}

/** A business day as a Hebrew date ("21 בנובמבר 2026"); null for anything that is not a real YYYY-MM-DD. */
export function trialEndLabel(day: string | null): string | null {
  const date = realDay(day);
  if (!date) return null;
  return new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

/** The same day with its weekday ("ביום שבת, 21 בנובמבר 2026"); null for anything that is not a real YYYY-MM-DD. */
export function trialEndWeekdayLabel(day: string | null): string | null {
  const date = realDay(day);
  const label = trialEndLabel(day);
  if (!date || !label) return null;
  const weekday = new Intl.DateTimeFormat("he-IL", { weekday: "long", timeZone: "UTC" }).format(date);
  return `ב${weekday}, ${label}`;
}

function footer(business: string): string {
  return `המייל נשלח לבעלי החשבון של ${business} במקסוז. זו הודעת שירות על החשבון, לא פרסומת. לשאלות אפשר לפנות אלינו: ${SUPPORT_PHONE} (גם ב-WhatsApp).`;
}

export function buildSignupEmail(input: SignupEmailInput): SignupEmail | null {
  const business = cleanName(input.businessName);
  const neutral = business === NEUTRAL_BUSINESS_NAME;
  const name = greetingName(input.firstName);
  const hello = name ? `שלום ${name},` : "שלום,";
  const of = neutral ? "העסק" : business;
  if (input.kind === "welcome") {
    const until = trialEndLabel(input.trialEndDay);
    const { business: home, users, intake, imports } = input.links;
    const subject = neutral ? "ברוכים הבאים למקסוז" : `ברוכים הבאים למקסוז, ${business}`.slice(0, 255);
    const text = [
      hello,
      `החשבון של ${of} במקסוז נפתח.`,
      "",
      "כמה דברים שכדאי לעשות עכשיו:",
      `להוסיף את העובדים: ${users}`,
      `לחבר טופס פניות לאתר: ${intake}`,
      `לייבא לקוחות מאקסל: ${imports}`,
      "",
      ...(until ? [`תקופת הניסיון פעילה עד ${until}.`, ""] : []),
      `לכניסה לעסק: ${home}`,
      "",
      "—",
      footer(of),
    ].join("\n");
    return { subject, text, links: [users, intake, imports, home] };
  }
  const until = trialEndWeekdayLabel(input.trialEndDay);
  if (!until) return null;
  const subject = (neutral ? "תקופת הניסיון במקסוז מסתיימת בקרוב" : `תקופת הניסיון של ${business} במקסוז מסתיימת בקרוב`).slice(0, 255);
  const text = [
    hello,
    `תקופת הניסיון של ${of} במקסוז מסתיימת ${until}.`,
    "כדי להמשיך לעבוד בלי הפסקה, אפשר לבחור חבילה במסך החבילה:",
    input.links.plan,
    "",
    "—",
    footer(of),
  ].join("\n");
  return { subject, text, links: [input.links.plan] };
}
