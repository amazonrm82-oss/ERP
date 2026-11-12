/**
 * LND-20 v2 (8): the landing page's "נחזור אליכם" form. It is an ordinary lead form of Mexuz's own business (MEXUZ Systems):
 * the server checks Turnstile (action `contact`) and then hands the inquiry to the public intake of that business's form
 * (SUPPORT.formUrl, the same code as POST /api/forms/<token>), with its own limits. Shared by the browser and the server.
 */
export const CONTACT_BUSINESS_TYPES = [
  "שירותים מקצועיים",
  "קליניקה או טיפולים",
  "קבלנות ושיפוצים",
  "מסחר וחנות",
  "סטודיו, יופי ובריאות",
  "אחר",
] as const;

/** The public intake's honeypot and fill-time fields (src/features/intake/fields.ts; the same names, unit test), written out
 * here so the landing page's browser code does not pull the custom-field code behind that file. */
export const CONTACT_HONEYPOT_FIELD = "website_url";
export const CONTACT_STARTED_FIELD = "_started";

export const CONTACT_CONSENT_VERSION = "contact-draft-1";

// DRAFT wording (version contact-draft-1), until the lawyer edits it
export const CONTACT_CONSENT_TEXT = "אני מאשר/ת שתחזרו אליי בטלפון או ב-WhatsApp לגבי Mexuz.";

/** The inquiry's message: the business type and the consent with its wording version (the form keeps the message). */
export function contactMessage(businessType: string | null, consentVersion: string): string {
  const lines = [];
  if (businessType) lines.push(`סוג העסק: ${businessType}`);
  lines.push(`אישור לחזרה בטלפון או ב-WhatsApp: כן (נוסח ${consentVersion})`);
  lines.push("נשלח מטופס \"נחזור אליכם\" בדף הבית");
  return lines.join("\n");
}

/** The hosts on which Mexuz's own form address may sit: this deployment's (NEXT_PUBLIC_SITE_URL) and the two fixed ones. */
export function contactFormHosts(siteUrl: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): string[] {
  const hosts = ["mexuzsystem.com", "erp-3yft.vercel.app"];
  try {
    if (siteUrl?.trim()) hosts.push(new URL(siteUrl.trim()).hostname.toLowerCase());
  } catch {
    // a malformed site address adds nothing
  }
  return hosts;
}

/**
 * The token of Mexuz's form from the address the app uses (SUPPORT.formUrl: NEXT_PUBLIC_CONTACT_FORM_URL, else
 * CONTACT_FORM_PATH), or null. Accepted: a same-site path "/f/<32 hex>", or an https address on one of `hosts` whose path is
 * exactly that, with no user, port, query or fragment. Anything else is not this deployment's form and gives null.
 */
export function contactFormToken(address: string, hosts: readonly string[] = contactFormHosts()): string | null {
  const text = address.trim();
  const token = (path: string) => /^\/f\/([0-9a-f]{32})$/.exec(path)?.[1] ?? null;
  if (text.startsWith("/")) return text.startsWith("//") ? null : token(text);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  if (!hosts.includes(url.hostname.toLowerCase())) return null;
  return token(url.pathname);
}

/**
 * Owner (343) ב: the business type is its own select field on the "צור קשר באתר" form, whose key the server reads from
 * CONTACT_BUSINESS_TYPE_FIELD (a custom field key of leads: a-z, digits, "_", up to 40). The six options above are exactly the
 * select's options. Unset or malformed = the type rides in the inquiry's message, as before.
 */
export function contactBusinessTypeField(value: string | undefined): string | null {
  const key = value?.trim() ?? "";
  return /^[a-z][a-z0-9_]{0,39}$/.test(key) ? key : null;
}

export const CONTACT_TEXTS = {
  consent: "צריך לסמן את האישור כדי שנוכל לחזור אליכם.",
  type: "בחרו סוג עסק מהרשימה.",
  unavailable: "הטופס לא זמין כרגע. אפשר לכתוב לנו ב-WhatsApp.",
} as const;
