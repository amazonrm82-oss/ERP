import { BLANK, DETAILS } from "./documents";

// FXS-09: the database keeps the fingerprint of each signed document per version (app.agreement_texts) and refuses a
// signature on any other text. The fingerprint is sha256(hex(sha256(title)) + hex(sha256(text))), UTF-8 throughout, over
// the title and text of agreementSnapshot(): two fixed-length digests, so no part of the text can move into the title or
// back without changing it. In SQL: app.agreement_fingerprint(title, text). Hashing happens in tests and in the database
// only, so this file stays free of node APIs.

type SnapshotDocument = { title: string; text: string };

/** The two strings the fingerprint is made of, in order: the title, then the text. */
export function fingerprintParts(doc: SnapshotDocument): [string, string] {
  return [doc.title, doc.text];
}

/**
 * The same string with every owner detail (BLANK placeholders and DETAILS values) replaced by a fixed token. Filling
 * contact details into a draft does not open a version (owner, 12 October 2026), so it leaves this template unchanged;
 * any other change of wording changes it, and then LEGAL_VERSION must change too (tests/unit/legal-fingerprint.test.ts).
 */
export function templateInput(
  doc: SnapshotDocument,
  owner: { blank: Record<string, string>; details: Record<string, string> } = { blank: BLANK, details: DETAILS },
): string {
  // the pinned wording (tests/unit/fixtures/legal-templates.json) is of this one string
  let text = `${doc.title}\n\n${doc.text}`;
  const values: Array<[string, string]> = [
    ...Object.entries(owner.blank).map(([key, value]): [string, string] => [`{{blank.${key}}}`, value]),
    ...Object.entries(owner.details).map(([key, value]): [string, string] => [`{{details.${key}}}`, value]),
  ];
  // longer values first, so a value that contains another is replaced whole
  values.sort((a, b) => b[1].length - a[1].length);
  for (const [token, value] of values) {
    text = text.split(value).join(token);
  }
  return text;
}
