// A contact card (vCard 3.0) that a phone imports into its contacts, so the
// business sees who is calling (GAP-02). Plain text, no dependency.

export type VCardPerson = {
  name: string;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  birthday?: string | null; // YYYY-MM-DD
  // BIZ-02: a web site (http or https only)
  url?: string | null;
  // CON-01: the type of the primary phone / email (mobile | work | home | other); a phone without one is CELL
  phoneType?: string | null;
  emailType?: string | null;
  // CON-01: a contact's further phones and emails, with their type (mobile | work | home | other)
  extraPhones?: Array<{ value: string; type: string }>;
  extraEmails?: Array<{ value: string; type: string }>;
};

const VCARD_PHONE_TYPE: Record<string, string> = { mobile: "CELL", work: "WORK", home: "HOME", other: "VOICE" };
const VCARD_EMAIL_TYPE: Record<string, string> = { work: "WORK", home: "HOME", other: "INTERNET" };

// vCard 3.0 (RFC 2426; the same in RFC 6350 3.4): backslash, comma, semicolon and line
// breaks are escaped. The backslash goes first, so the ones added here are not doubled.
// A line break is CRLF, LF or a lone CR; each becomes one "\n".
export function escapeVCardText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

// lines longer than 75 octets are folded; a fold never splits a character
function fold(line: string): string {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (bytes(line) <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const char of line) {
    if (bytes(current + char) > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = "";
    }
    current += char;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function buildVCard(person: VCardPerson): string {
  const name = person.name.trim() || "ללא שם";
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${escapeVCardText(name)}`, `N:${escapeVCardText(name)};;;;`];
  if (person.phone?.trim()) lines.push(`TEL;TYPE=${VCARD_PHONE_TYPE[person.phoneType ?? ""] ?? "CELL"}:${escapeVCardText(person.phone.trim())}`);
  for (const phone of person.extraPhones ?? []) {
    if (phone.value.trim()) lines.push(`TEL;TYPE=${VCARD_PHONE_TYPE[phone.type] ?? "VOICE"}:${escapeVCardText(phone.value.trim())}`);
  }
  if (person.email?.trim()) lines.push(person.emailType && VCARD_EMAIL_TYPE[person.emailType] ? `EMAIL;TYPE=${VCARD_EMAIL_TYPE[person.emailType]}:${escapeVCardText(person.email.trim())}` : `EMAIL:${escapeVCardText(person.email.trim())}`);
  for (const email of person.extraEmails ?? []) {
    if (email.value.trim()) lines.push(`EMAIL;TYPE=${VCARD_EMAIL_TYPE[email.type] ?? "INTERNET"}:${escapeVCardText(email.value.trim())}`);
  }
  if (person.company?.trim()) lines.push(`ORG:${escapeVCardText(person.company.trim())}`);
  if (person.jobTitle?.trim()) lines.push(`TITLE:${escapeVCardText(person.jobTitle.trim())}`);
  if (person.birthday && /^\d{4}-\d{2}-\d{2}$/.test(person.birthday)) lines.push(`BDAY:${person.birthday}`);
  if (person.url && /^https?:\/\/\S+$/i.test(person.url.trim())) lines.push(`URL:${escapeVCardText(person.url.trim())}`);
  lines.push("END:VCARD");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** An ASCII file name for Content-Disposition, plus the real name for browsers that read filename*. */
export function vcardDisposition(name: string): string {
  return `attachment; filename="contact.vcf"; filename*=UTF-8''${encodeURIComponent(`${name.trim() || "contact"}.vcf`)}`;
}
