import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AGREEMENT_SLUGS, AGREEMENT_VERSION, agreementSnapshot } from "@/features/legal/agreement";
import { BLANK, DETAILS } from "@/features/legal/documents";
import { fingerprintParts, templateInput } from "@/features/legal/fingerprint";

import templates from "./fixtures/legal-templates.json";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const fingerprint = (doc: { title: string; text: string }) => {
  const [title, text] = fingerprintParts(doc);
  return sha(sha(title) + sha(text));
};

// FXS-09. The wording of each version, with the owner's details masked, is pinned here. A changed wording needs a new
// LEGAL_VERSION (owner rule) and a new entry below, never an edited one. Filling the owner's details into a draft keeps
// the version and leaves these hashes as they are; the database then needs the filled texts' fingerprints registered
// (a migration adding rows to app.agreement_texts; tests/db/127 checks that).
describe("legal texts and their versions (FXS-09)", () => {
  it("the current wording is the wording of its version", () => {
    const pinned = (templates as Record<string, Record<string, string>>)[AGREEMENT_VERSION];
    expect(pinned, `no wording is pinned for LEGAL_VERSION ${AGREEMENT_VERSION}; add it to tests/unit/fixtures/legal-templates.json`).toBeDefined();
    const now = Object.fromEntries(agreementSnapshot().map((doc) => [doc.slug, sha(templateInput(doc))]));
    expect(now, "the wording changed without a new LEGAL_VERSION (src/features/legal/documents.ts)").toEqual(pinned);
    expect(Object.keys(now)).toEqual([...AGREEMENT_SLUGS]);
  });

  it("every document carries the agreement's version", () => {
    for (const doc of agreementSnapshot()) expect(doc.version).toBe(AGREEMENT_VERSION);
  });

  it("filling the owner's details changes the signed text but not the wording; rewording changes both", () => {
    const [doc] = agreementSnapshot();
    const company = "מקסוז בע\"מ, ח.פ. 512345678";
    const filled = { title: doc.title, text: doc.text.split(BLANK.company).join(company) };
    expect(filled.text).not.toBe(doc.text);
    // the database needs the filled text's own fingerprint ...
    expect(fingerprint(filled)).not.toBe(fingerprint(doc));
    // ... while the wording, with the owner's details masked, stays that of the same version
    const filledOwner = { blank: { ...BLANK, company }, details: { ...DETAILS } };
    expect(sha(templateInput(filled, filledOwner))).toBe(sha(templateInput(doc)));
    const reworded = { title: doc.title, text: doc.text.replace("השירות", "המערכת") };
    expect(sha(templateInput(reworded))).not.toBe(sha(templateInput(doc)));
  });

  it("the fingerprint keeps the title and the text apart: moving the boundary changes it", () => {
    const doc = { title: "כותרת", text: "1. כללי\nפסקה\n\n2. חשבון\nפסקה" };
    expect(fingerprintParts(doc)).toEqual([doc.title, doc.text]);
    // the first clause moved into the title: one joined string (title, empty line, text) cannot tell them apart ...
    const shifted = { title: "כותרת\n\n1. כללי\nפסקה", text: "2. חשבון\nפסקה" };
    expect(`${shifted.title}\n\n${shifted.text}`).toBe(`${doc.title}\n\n${doc.text}`);
    // ... the fingerprint can
    expect(fingerprint(shifted)).not.toBe(fingerprint(doc));
  });

});
