import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { AGREEMENT_SLUGS, AGREEMENT_VERSION, agreementSnapshot } from "@/features/legal/agreement";
import { fingerprintParts } from "@/features/legal/fingerprint";

import { asAdmin, asAnon, asUser, closePool, count, createUser, pgError } from "./helpers";
import { MIGRATIONS_DIR, migrationFile } from "./rerun";

afterAll(closePool);

type Doc = { slug: string; title: string; version: string; text: string };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const fingerprint = (doc: { title: string; text: string }) => {
  const [title, text] = fingerprintParts(doc);
  return sha(sha(title) + sha(text));
};
const sign = (userId: string, docs: unknown, version: string = AGREEMENT_VERSION) =>
  asUser(userId, (q) => q("select public.sign_agreement($1, $2, 'דנה כהן', 'typed', null)", [version, JSON.stringify(docs)]));
const signatures = (userId: string) => asAdmin((q) => count(q, "select 1 from app.agreement_signatures where user_id = $1", [userId]));

// FXS-09: a signature is accepted only on the registered texts of its version, so a direct call with the right version
// and another text is refused; the app's current texts are registered (a text changed without a migration fails here).
describe("the agreement is signed only on its own text (FXS-09)", () => {
  it("the app's current texts are the registered ones of its version, hashed the same way on both sides", async () => {
    const registered = await asAdmin(async (q) =>
      (await q<{ slug: string; text_hash: string }>("select slug, text_hash from app.agreement_texts where version = $1", [AGREEMENT_VERSION])).rows,
    );
    expect([...new Set(registered.map((r) => r.slug))].sort()).toEqual([...AGREEMENT_SLUGS].sort());
    for (const doc of agreementSnapshot()) {
      expect(
        registered.some((r) => r.slug === doc.slug && r.text_hash === fingerprint(doc)),
        `the text of "${doc.slug}" changed: a new wording needs a new LEGAL_VERSION, a filled-in detail a migration registering its fingerprint`,
      ).toBe(true);
    }
    // the database hashes the same string as the app
    for (const doc of agreementSnapshot()) {
      const inDb = await asAdmin(async (q) => (await q<{ h: string }>("select app.agreement_fingerprint($1, $2) as h", [doc.title, doc.text])).rows[0].h);
      expect(inDb, doc.slug).toBe(fingerprint(doc));
    }
  });

  it("the app's snapshot is signed and stored as sent", async () => {
    const user = await createUser("fp-signer");
    await sign(user.id, agreementSnapshot());
    const stored = await asAdmin(async (q) => (await q<{ documents: Doc[]; version: string }>("select documents, version from app.agreement_signatures where user_id = $1", [user.id])).rows[0]);
    expect(stored.version).toBe(AGREEMENT_VERSION);
    expect(stored.documents).toEqual(agreementSnapshot());
    // the documents in another order are the same agreement
    await sign(user.id, [...agreementSnapshot()].reverse());
    expect(await signatures(user.id)).toBe(2);
  });

  it("refuses another text, another title, another version, a missing, doubled or extra document, and anything added to one", async () => {
    const user = await createUser("fp-forger");
    const docs = agreementSnapshot();
    const with0 = (patch: (doc: Doc) => unknown) => [patch({ ...docs[0] }), ...docs.slice(1)];
    const cases: Array<[string, unknown, string?]> = [
      ["one character of the text", with0((d) => ({ ...d, text: d.text + " " }))],
      ["a clause removed", with0((d) => ({ ...d, text: d.text.split("\n\n").slice(1).join("\n\n") }))],
      ["another title", with0((d) => ({ ...d, title: d.title + " (מקוצר)" }))],
      // the first clause moved into the title: title, empty line and text joined are the same string as before
      ["the boundary between title and text moved", with0((d) => {
        const [first, ...rest] = (d as Doc).text.split("\n\n");
        return { ...d, title: `${(d as Doc).title}\n\n${first}`, text: rest.join("\n\n") };
      })],
      ["a document's version", with0((d) => ({ ...d, version: "2020-01-01" }))],
      ["an extra key", with0((d) => ({ ...d, note: "טקסט נוסף" }))],
      ["a key missing", with0((d) => ({ slug: (d as Doc).slug, title: (d as Doc).title, text: (d as Doc).text }))],
      ["a number for the text", with0((d) => ({ ...d, text: 1 }))],
      ["a string instead of a document", with0(() => "terms")],
      ["a document missing", docs.slice(1)],
      ["a document doubled", [docs[0], docs[0], docs[1]]],
      ["a fourth document", [...docs, { ...docs[0], slug: "extra" }]],
      ["the texts under each other's names", [{ ...docs[0], slug: docs[1].slug }, { ...docs[1], slug: docs[0].slug }, docs[2]]],
      ["an unknown version", docs.map((d) => ({ ...d, version: "2099-01-01" })), "2099-01-01"],
      ["an older version name with today's texts", docs.map((d) => ({ ...d, version: "2026-10-07" })), "2026-10-07"],
    ];
    for (const [what, sent, version] of cases) {
      const refused = await pgError(sign(user.id, sent, version));
      expect(refused.code, what).toBe("P0001");
      expect(refused.hint, what).toBe("agreement:changed");
    }
    expect(await signatures(user.id)).toBe(0);
    // the earlier checks keep their answers
    expect((await pgError(sign(user.id, []))).code).toBe("22023");
    expect((await pgError(asAnon((q) => q("select public.sign_agreement($1, $2, 'דנה כהן', 'typed', null)", [AGREEMENT_VERSION, JSON.stringify(docs)])))).code).toBe("42501");
  });

  it("a filled-in draft registered under the same version is signed, and the earlier text of that version still is", async () => {
    const user = await createUser("fp-filled");
    const docs = agreementSnapshot();
    const filled = { ...docs[0], text: docs[0].text.replace("[שם הישות העסקית ומספר החברה]", "חברה לדוגמה בע\"מ") };
    expect(filled.text).not.toBe(docs[0].text);
    expect((await pgError(sign(user.id, [filled, ...docs.slice(1)]))).hint).toBe("agreement:changed");
    await asAdmin((q) => q("insert into app.agreement_texts (version, slug, text_hash) values ($1, $2, $3)", [AGREEMENT_VERSION, filled.slug, fingerprint(filled)]));
    try {
      await sign(user.id, [filled, ...docs.slice(1)]);
      await sign(user.id, docs);
      expect(await signatures(user.id)).toBe(2);
    } finally {
      // a test-only row; the real table never loses one
      await asAdmin((q) => q("delete from app.agreement_texts where version = $1 and slug = $2 and text_hash = $3", [AGREEMENT_VERSION, filled.slug, fingerprint(filled)]));
    }
  });

  it("a text registered only for another version is refused for this one", async () => {
    const user = await createUser("fp-cross");
    const docs = agreementSnapshot();
    const other = "2099-12-31";
    const filled = { ...docs[0], text: docs[0].text.replace("[שם הישות העסקית ומספר החברה]", "חברה לדוגמה בע\"מ") };
    const otherDocs = [filled, ...docs.slice(1)].map((d) => ({ ...d, version: other }));
    // version B: the filled terms and today's other two texts
    await asAdmin(async (q) => {
      for (const d of otherDocs) {
        await q("insert into app.agreement_texts (version, slug, text_hash) values ($1, $2, $3)", [other, d.slug, fingerprint(d)]);
      }
    });
    try {
      // the filled terms are registered for version B only: signing version A with them is refused
      const refused = await pgError(sign(user.id, [{ ...filled, version: AGREEMENT_VERSION }, ...docs.slice(1)]));
      expect(refused.hint).toBe("agreement:changed");
      expect(await signatures(user.id)).toBe(0);
      // under version B they are signed
      await sign(user.id, otherDocs, other);
      expect(await signatures(user.id)).toBe(1);
    } finally {
      await asAdmin((q) => q("delete from app.agreement_texts where version = $1", [other]));
    }
  });

  it("the fingerprints are not reachable from the API, and the migration runs twice without touching a signature", async () => {
    const user = await createUser("fp-api");
    for (const sql of ["select * from app.agreement_texts", "insert into app.agreement_texts (version, slug, text_hash) values ('x', 'terms', repeat('a', 64))"]) {
      expect((await pgError(asUser(user.id, (q) => q(sql)))).code).toBe("42501");
    }
    // a signature made before this check existed (any text) stays as it is
    await asAdmin((q) =>
      q(
        `insert into app.agreement_signatures (user_id, version, documents, content_hash, full_name, method)
         values ($1, '2026-10-07', '[{"slug":"terms","title":"ישן","text":"נוסח ישן"}]', repeat('b', 64), 'דנה כהן', 'typed')`,
        [user.id],
      ),
    );
    const before = await asAdmin(async (q) => (await q("select * from app.agreement_signatures order by id")).rows);
    const rowsBefore = await asAdmin((q) => count(q, "select 1 from app.agreement_texts"));
    const sql = readFileSync(join(MIGRATIONS_DIR, migrationFile("_agreement_fingerprints.sql")), "utf8");
    await asAdmin((q) => q(sql));
    await asAdmin((q) => q(sql));
    expect(await asAdmin(async (q) => (await q("select * from app.agreement_signatures order by id")).rows)).toEqual(before);
    expect(await asAdmin((q) => count(q, "select 1 from app.agreement_texts"))).toBe(rowsBefore);
    expect(await asUser(user.id, async (q) => (await q<{ r: string }>("select public.agreement_status() as r")).rows[0].r)).toBe("2026-10-07");
  });
});
