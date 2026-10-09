// A contact card (vCard 3.0) that a phone imports into its contacts, so the
// business sees who is calling (GAP-02). Plain text, no dependency.

export type VCardPerson = {
  name: string;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  birthday?: string | null; // YYYY-MM-DD
};

// RFC 6350 3.4: backslash, comma, semicolon and line breaks are escaped
function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\;");
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
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${escape(name)}`, `N:${escape(name)};;;;`];
  if (person.phone?.trim()) lines.push(`TEL;TYPE=CELL:${escape(person.phone.trim())}`);
  if (person.email?.trim()) lines.push(`EMAIL:${escape(person.email.trim())}`);
  if (person.company?.trim()) lines.push(`ORG:${escape(person.company.trim())}`);
  if (person.jobTitle?.trim()) lines.push(`TITLE:${escape(person.jobTitle.trim())}`);
  if (person.birthday && /^\d{4}-\d{2}-\d{2}$/.test(person.birthday)) lines.push(`BDAY:${person.birthday}`);
  lines.push("END:VCARD");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** An ASCII file name for Content-Disposition, plus the real name for browsers that read filename*. */
export function vcardDisposition(name: string): string {
  return `attachment; filename="contact.vcf"; filename*=UTF-8''${encodeURIComponent(`${name.trim() || "contact"}.vcf`)}`;
}
