import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONSENT_TARGET,
  consentChannelOf,
  consentDeclarationSchema,
  consentResultWarning,
  consentsUndoneText,
  IMPORT_CONSENT_METHOD_LABELS,
  IMPORT_CONSENT_METHODS,
  mapsConsent,
  parseConsentCell,
} from "@/features/imports/consent";
import { IMPORT_TARGETS, suggestMapping } from "@/features/imports/fields";
import { CONSENT_ROW_SKIPPED, CONSENTS_FAILED, processChunk, type ImportContext } from "@/features/imports/server";
import { normalizePhone } from "@/lib/phone";

// CNS-05: consent columns in a leads or contacts import

const dir = join(process.cwd(), "supabase/migrations");
const file = readdirSync(dir).find((name) => name.endsWith("_import_consent.sql"));
const sql = readFileSync(join(dir, file as string), "utf8");

describe("consent cell values (closed list, never guessed)", () => {
  it("reads yes and no in Hebrew and English, case and spaces aside", () => {
    for (const v of ["כן", " כן ", "מאשר", "מאשרת", "מסכים", "מסכימה", "Yes", "Y", "TRUE", "1", "v", "✓"]) {
      expect(parseConsentCell(v), v).toBe("granted");
    }
    for (const v of ["לא", "לא  מאשר", "לא מאשרת", "לא מסכים", "No", "n", "False", "0", "X", "✗"]) {
      expect(parseConsentCell(v), v).toBe("denied");
    }
  });

  it("takes the owner's added values of 26 October 2026 (answer 3), trimmed and in any case", () => {
    for (const v of ["v", "V", " v ", "✔", "אישר", " אישר ", "מאשרת", "מסכימה", "אושר", "  אושר"]) {
      expect(parseConsentCell(v), v).toBe("granted");
    }
    for (const v of ["x", "X", " x "]) expect(parseConsentCell(v), v).toBe("denied");
    // still never guessed
    for (const v of ["לא אישר", "אושרה?", "vv", "xx", "✔✔"]) expect(parseConsentCell(v), v).toBe("invalid");
  });

  it("an empty cell writes nothing; anything else is invalid", () => {
    for (const v of ["", "   ", null, undefined]) expect(parseConsentCell(v)).toBeNull();
    for (const v of ["אולי", "כן?", "yes please", "2", "-", "נכון", "opt-in", "withdrawn"]) expect(parseConsentCell(v), v).toBe("invalid");
  });
});

describe("mapping", () => {
  it("leads and contacts offer the three channels; other objects none", () => {
    for (const entity of ["lead", "contact"] as const) {
      const keys = IMPORT_TARGETS[entity].map((t) => t.key);
      expect(keys).toEqual(expect.arrayContaining(Object.values(CONSENT_TARGET)));
    }
    for (const entity of ["company", "deal", "task", "product"] as const) {
      expect(IMPORT_TARGETS[entity].some((t) => consentChannelOf(t.key))).toBe(false);
    }
    expect(mapsConsent(["full_name", "", "consent_sms"])).toBe(true);
    expect(mapsConsent(["full_name", "email"])).toBe(false);
  });

  it("suggests a consent column only from its own headers, never from a generic one", () => {
    const targets = IMPORT_TARGETS.lead;
    expect(suggestMapping(["אימייל", "הסכמה לאימייל", "הסכמה ל-SMS", "whatsapp consent"], targets)).toEqual([
      "email",
      "consent_email",
      "consent_sms",
      "consent_whatsapp",
    ]);
    expect(suggestMapping(["הסכמה", "דיוור", "marketing"], targets)).toEqual(["", "", ""]);
  });
});

describe("the declaration", () => {
  it("the methods and labels equal the migration's list and labels", () => {
    const constraint = sql.match(/check \(consent_method in \(([^)]*)\)\)/);
    expect(constraint).not.toBeNull();
    const codes = [...(constraint as RegExpMatchArray)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes).toEqual([...IMPORT_CONSENT_METHODS]);
    for (const method of IMPORT_CONSENT_METHODS) {
      expect(sql, method).toContain(`when '${method}' then '${IMPORT_CONSENT_METHOD_LABELS[method]}'`);
    }
  });

  it("needs a method from the list and a note of 1..500", () => {
    expect(consentDeclarationSchema.safeParse({ method: "website_form", note: " רשימה מהאתר " }).data).toEqual({ method: "website_form", note: "רשימה מהאתר" });
    expect(consentDeclarationSchema.safeParse({ method: "", note: "x" }).success).toBe(false);
    expect(consentDeclarationSchema.safeParse({ method: "rumour", note: "x" }).success).toBe(false);
    expect(consentDeclarationSchema.safeParse({ method: "other", note: "   " }).success).toBe(false);
    expect(consentDeclarationSchema.safeParse({ method: "other", note: "x".repeat(501) }).success).toBe(false);
  });
});

describe("what the summary says", () => {
  it("names a consent kept out by an opt-out, and is silent for a written one", () => {
    expect(consentResultWarning("email", "written")).toBeNull();
    expect(consentResultWarning("sms", "locked")).toBe("ההסכמה ל-SMS לא עודכנה: הכתובת חסומה לדיוור בעסק.");
    expect(consentResultWarning("email", "other_address")).toContain("האימייל בקובץ אינו הראשי");
    expect(consentResultWarning("whatsapp", "refused")).toBe("ההסכמה ל-WhatsApp לא נרשמה.");
  });
});

/** A stand-in for the user's session in a create-mode leads import: inserts return ids, the consent RPC answers. */
// The records come back in REVERSE order (the import must match them by address, never by position); `returned`
// changes what the insert answers. `existing` are the duplicates import_find_duplicates finds.
function fakeSupabase(
  answer: (items: Array<Record<string, unknown>>) => { data: unknown; error: unknown },
  options: { existing?: Array<{ id: string; phone_e164: string | null; email: string | null }>; returned?: (records: unknown[]) => unknown[] } = {},
) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let next = 0;
  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "import_find_duplicates") {
        return { data: (options.existing ?? []).map((e) => ({ ...e, tax_id: null, name: null })), error: null };
      }
      calls.push({ fn, args });
      return answer(args.p_items as Array<Record<string, unknown>>);
    },
    from: () => ({
      insert: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => {
        const list = Array.isArray(rows) ? rows : [rows];
        const records = list
          .map((r) => ({ id: `id-${++next}`, phone_e164: normalizePhone((r.phone as string | null) ?? null), email: (r.email as string | null) ?? null }))
          .reverse();
        const data = options.returned ? options.returned(records) : records;
        return Object.assign(Promise.resolve({ error: null }), { select: async () => ({ data, error: null }) });
      },
    }),
  };
  return { supabase, calls };
}

const lookups = { statuses: new Map(), defaultStatus: "s", sources: new Map(), owners: new Map(), disqualified: new Set<string>(), reasons: new Set<string>() };
const MAP = ["full_name", "phone", "email", "consent_email", "consent_sms", "consent_whatsapp"];
const ctxOf = (supabase: unknown, consentDeclared: boolean, mode: "create" | "skip" = "create") =>
  ({ supabase, orgId: "org", userId: "u", entity: "lead", mode, mapping: MAP, definitions: [], consentDeclared }) as unknown as ImportContext;

describe("the import writes the rows' consents through the database (CNS-05)", () => {
  const rows = [
    ["דנה", "050-7700001", "dana@example.test", "כן", "לא", ""],
    ["רון", "", "ron@example.test", "אולי", "כן", ""],
  ];

  it("sends one item per known value with an address, and reports what was written and what was kept out", async () => {
    const { supabase, calls } = fakeSupabase((items) => ({ data: items.map((i) => (i.channel === "sms" ? "locked" : "written")), error: null }));
    const outcomes = await processChunk(ctxOf(supabase, true), lookups, rows, 1, "job");
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("import_record_consents");
    expect(calls[0].args.p_items).toEqual([
      { record_id: "id-1", channel: "email", state: "granted", address: "dana@example.test" },
      { record_id: "id-1", channel: "sms", state: "denied", address: "+972507700001" },
    ]);
    expect(outcomes[0]).toMatchObject({ status: "created", consents: 1, consentsLocked: 1, warning: "ההסכמה ל-SMS לא עודכנה: הכתובת חסומה לדיוור בעסק." });
    // row 2: an unknown value and an SMS consent without a phone are not sent; the row is still imported
    expect(outcomes[1].status).toBe("created");
    expect(outcomes[1].warning).toContain('הערך "אולי" בעמודת ההסכמה לאימייל לא מוכר');
    expect(outcomes[1].warning).toContain("אין בשורה טלפון, ולכן ההסכמה ל-SMS לא נרשמה.");
    expect(outcomes[1].consents).toBeUndefined();
  });

  it("the preview only warns; without a declaration nothing is sent; a failed call says so on the row", async () => {
    const preview = fakeSupabase(() => ({ data: [], error: null }));
    const shown = await processChunk(ctxOf(preview.supabase, true), lookups, rows, 1, null);
    expect(preview.calls).toHaveLength(0);
    expect(shown[1].warning).toContain("לא מוכר");

    const undeclared = fakeSupabase(() => ({ data: [], error: null }));
    await processChunk(ctxOf(undeclared.supabase, false), lookups, rows, 1, "job");
    expect(undeclared.calls).toHaveLength(0);

    const broken = fakeSupabase(() => ({ data: null, error: { message: "boom" } }));
    const outcomes = await processChunk(ctxOf(broken.supabase, true), lookups, rows, 1, "job");
    expect(outcomes[0]).toMatchObject({ status: "created", warning: CONSENTS_FAILED });
  });
});

describe("review of 8274c04 (CNS-05)", () => {
  it("a new record is found by its addresses; when the insert's answer does not fit, the consents are reported as failed", async () => {
    const rows = [
      ["דנה", "050-7700001", "dana@example.test", "כן", "", ""],
      ["רון", "050-7700002", "ron@example.test", "לא", "", ""],
    ];
    const shuffled = fakeSupabase((items) => ({ data: items.map(() => "written"), error: null }));
    await processChunk(ctxOf(shuffled.supabase, true), lookups, rows, 1, "job");
    // the fake answered in reverse order: id-1 is Dana's record, id-2 Ron's
    const items = shuffled.calls[0].args.p_items as Array<Record<string, unknown>>;
    expect(items.map((i) => [i.record_id, i.address])).toEqual([
      ["id-1", "dana@example.test"],
      ["id-2", "ron@example.test"],
    ]);

    const short = fakeSupabase(() => ({ data: [], error: null }), { returned: (records) => records.slice(1) });
    const outcomes = await processChunk(ctxOf(short.supabase, true), lookups, rows, 1, "job");
    expect(short.calls).toHaveLength(0);
    expect(outcomes.map((o) => [o.status, o.warning])).toEqual([
      ["created", CONSENTS_FAILED],
      ["created", CONSENTS_FAILED],
    ]);
  });

  it("a row skipped as a duplicate sends only its 'denied' to the matched record; the rest is named on the row", async () => {
    const existing = [{ id: "old", phone_e164: "+972507700001", email: "dana@example.test" }];
    const rows = [["דנה", "050-7700001", "dana@example.test", "כן", "לא", ""]];
    const preview = fakeSupabase(() => ({ data: [], error: null }), { existing });
    const shown = await processChunk(ctxOf(preview.supabase, true, "skip"), lookups, rows, 1, null);
    expect(shown[0]).toMatchObject({ status: "skipped", warning: CONSENT_ROW_SKIPPED });

    const run = fakeSupabase((items) => ({ data: items.map(() => "written"), error: null }), { existing });
    const outcomes = await processChunk(ctxOf(run.supabase, true, "skip"), lookups, rows, 1, "job");
    expect(run.calls[0].args.p_items).toEqual([{ record_id: "old", channel: "sms", state: "denied", address: "+972507700001" }]);
    expect(outcomes[0]).toMatchObject({ status: "skipped", consents: 1, warning: CONSENT_ROW_SKIPPED });

    // the database refuses it (the caller may not edit the matched record): the row says it was skipped
    const refused = fakeSupabase((items) => ({ data: items.map(() => "refused"), error: null }), { existing });
    const denied = [["דנה", "050-7700001", "dana@example.test", "", "לא", ""]];
    const out = await processChunk(ctxOf(refused.supabase, true, "skip"), lookups, denied, 1, "job");
    expect(out[0]).toMatchObject({ status: "skipped", warning: CONSENT_ROW_SKIPPED });
    expect(out[0].consents).toBeUndefined();

    // a repeat of an earlier row in the file sends nothing
    const twice = fakeSupabase((items) => ({ data: items.map(() => "written"), error: null }));
    const repeat = [
      ["דנה", "050-7700009", "d9@example.test", "", "", ""],
      ["דנה", "050-7700009", "d9@example.test", "", "לא", ""],
    ];
    const res = await processChunk(ctxOf(twice.supabase, true, "skip"), lookups, repeat, 1, "job");
    expect(res[1]).toMatchObject({ status: "skipped", warning: CONSENT_ROW_SKIPPED });
    expect(twice.calls).toHaveLength(0);
  });
});

describe("undoing an import with consents (owner, 26 October 2026, answer 1)", () => {
  it("says how many consents were cancelled, and nothing when none were", () => {
    expect(consentsUndoneText(undefined)).toBe("");
    expect(consentsUndoneText(0)).toBe("");
    expect(consentsUndoneText(1)).toBe(" גם ההסכמה לדיוור שנרשמה בו בוטלה.");
    expect(consentsUndoneText(3)).toBe(" גם 3 ההסכמות לדיוור שנרשמו בו בוטלו.");
  });
});
