// WEB-05 (owner (418) ב): the fixed texts of the two service emails to a new sign-up (welcome, the trial is about to end).
// Pure. Service texts only (no tips, no offers); the business cannot edit them; the wording is a DRAFT until the owner
// approves it (SIGNUP_EMAIL_WORDING names the version).

export const SIGNUP_EMAIL_WORDING = "signup-draft-1";

export const SIGNUP_EMAIL_KINDS = ["welcome", "trial_ending"] as const;
export type SignupEmailKind = (typeof SIGNUP_EMAIL_KINDS)[number];

/** The word the composer sends instead of a business name that holds a link, an "@" or a "://" (USR-09's rule). */
export const NEUTRAL_BUSINESS_NAME = "העסק";

export type SignupEmailInput = {
  kind: SignupEmailKind;
  businessName: string;
  /** the trial's last day in the business's zone (YYYY-MM-DD); required for trial_ending */
  trialEndDay: string | null;
  /** the absolute link into the app: the business (welcome) or its plan screen (trial_ending) */
  link: string;
};

export type SignupEmail = { subject: string; text: string; links: string[] };

function cleanName(name: string): string {
  const flat = name.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return (flat || NEUTRAL_BUSINESS_NAME).slice(0, 80);
}

/** A business day as a Hebrew date ("21 בנובמבר 2026"); null for anything that is not a real YYYY-MM-DD. */
export function trialEndLabel(day: string | null): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

export function buildSignupEmail(input: SignupEmailInput): SignupEmail | null {
  const business = cleanName(input.businessName);
  const neutral = business === NEUTRAL_BUSINESS_NAME;
  const until = trialEndLabel(input.trialEndDay);
  const footer = "המייל נשלח ממקסוז אל בעלי החשבון. זו הודעת שירות על החשבון שלך. אין להשיב למייל הזה.";
  if (input.kind === "welcome") {
    const subject = neutral ? "ברוכים הבאים למקסוז" : `ברוכים הבאים למקסוז, ${business}`.slice(0, 255);
    const text = [
      "שלום,",
      neutral ? "החשבון של העסק במקסוז נפתח." : `החשבון של ${business} במקסוז נפתח.`,
      ...(until ? [`תקופת הניסיון פעילה עד ${until}.`] : []),
      "",
      `לכניסה לעסק: ${input.link}`,
      "",
      "—",
      footer,
    ].join("\n");
    return { subject, text, links: [input.link] };
  }
  if (!until) return null;
  const subject = (neutral ? "תקופת הניסיון במקסוז מסתיימת בקרוב" : `תקופת הניסיון של ${business} במקסוז מסתיימת בקרוב`).slice(0, 255);
  const text = [
    "שלום,",
    neutral ? `תקופת הניסיון של העסק במקסוז מסתיימת ב-${until}.` : `תקופת הניסיון של ${business} במקסוז מסתיימת ב-${until}.`,
    "כדי להמשיך לעבוד בלי הפסקה, אפשר לבחור חבילה במסך החבילה:",
    input.link,
    "",
    "—",
    footer,
  ].join("\n");
  return { subject, text, links: [input.link] };
}
