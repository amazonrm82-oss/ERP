import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hitsAnnouncement,
  initialChoice,
  moveActive,
  pickerLabelName,
  pickerQuery,
  SEARCH_PICKER_MAX_HITS,
} from "@/components/ui/search-picker-logic";
import { CONTACT_FALLBACK_NAME, contactHit, contactPickerName, PICKER_EXCLUDE_MAX, pickerExclude } from "@/features/contacts/picker";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";

describe("search picker logic", () => {
  it("searches only once the minimum is typed, trimmed", () => {
    expect(pickerQuery("")).toBeNull();
    expect(pickerQuery(" ד ")).toBeNull();
    expect(pickerQuery("  דנ ")).toBe("דנ");
    expect(pickerQuery("0", 1)).toBe("0");
  });

  it("moves through the options with the arrows, wrapping, and Home/End to the ends", () => {
    expect(moveActive(-1, "ArrowDown", 3)).toBe(0);
    expect(moveActive(0, "ArrowDown", 3)).toBe(1);
    expect(moveActive(2, "ArrowDown", 3)).toBe(0);
    expect(moveActive(-1, "ArrowUp", 3)).toBe(2);
    expect(moveActive(0, "ArrowUp", 3)).toBe(2);
    expect(moveActive(2, "ArrowUp", 3)).toBe(1);
    expect(moveActive(1, "Home", 3)).toBe(0);
    expect(moveActive(0, "End", 3)).toBe(2);
    // a list that shrank keeps the active option inside it; an empty list has none
    expect(moveActive(5, "x", 3)).toBe(2);
    expect(moveActive(1, "ArrowDown", 0)).toBe(-1);
  });

  it("carries the label next to the id, and starts from what a form holds", () => {
    expect(pickerLabelName("contact_id")).toBe("contact_id__label");
    expect(pickerLabelName("cf_builtin:contact_id")).toBe("cf_builtin:contact_id__label");
    expect(initialChoice(A, "דנה כהן", "איש קשר")).toEqual({ id: A, label: "דנה כהן" });
    expect(initialChoice(A, "  ", "איש קשר")).toEqual({ id: A, label: "איש קשר" });
    expect(initialChoice(A, undefined, "איש קשר")).toEqual({ id: A, label: "איש קשר" });
    expect(initialChoice("", "דנה", "איש קשר")).toBeNull();
    expect(initialChoice(null, null, "איש קשר")).toBeNull();
  });

  it("tells a screen reader what a search found", () => {
    expect(hitsAnnouncement(0)).toBe("לא נמצאו תוצאות.");
    expect(hitsAnnouncement(1)).toBe("נמצאה תוצאה אחת. בחירה בחיצים ובאנטר.");
    expect(hitsAnnouncement(7)).toBe("נמצאו 7 תוצאות. בחירה בחיצים ובאנטר.");
    expect(hitsAnnouncement(SEARCH_PICKER_MAX_HITS)).toBe(`נמצאו ${SEARCH_PICKER_MAX_HITS} תוצאות ראשונות. אפשר לדייק את החיפוש.`);
  });
});

describe("contact picker helpers", () => {
  it("names a contact by its full name, else email, else phone", () => {
    expect(contactPickerName({ full_name: "דנה כהן", email: "d@x.co", phone: "050" })).toBe("דנה כהן");
    expect(contactPickerName({ full_name: " ", email: "d@x.co", phone: "050" })).toBe("d@x.co");
    expect(contactPickerName({ full_name: null, email: null, phone: "050-1234567" })).toBe("050-1234567");
    expect(contactPickerName({ full_name: null, email: null, phone: null })).toBe(CONTACT_FALLBACK_NAME);
  });

  it("describes a hit by the phone and email that are not its name", () => {
    expect(contactHit({ id: A, full_name: "דנה", email: "d@x.co", phone: "050-1234567" })).toEqual({ id: A, label: "דנה", detail: "050-1234567 · d@x.co" });
    expect(contactHit({ id: A, full_name: null, email: "d@x.co", phone: null })).toEqual({ id: A, label: "d@x.co", detail: null });
    expect(contactHit({ id: A, full_name: "דנה", email: null, phone: null })).toEqual({ id: A, label: "דנה", detail: null });
  });

  it("leaves out valid ids only, each once, and refuses anything else", () => {
    expect(pickerExclude(undefined)).toEqual([]);
    expect(pickerExclude([A, B, A])).toEqual([A, B]);
    expect(pickerExclude([A, "1); drop"])).toBeNull();
    expect(pickerExclude("a")).toBeNull();
    expect(pickerExclude(Array.from({ length: PICKER_EXCLUDE_MAX * 2 + 1 }, () => A))).toBeNull();
  });
});

// The search itself, against a stand-in for the user's Supabase client: every read is held to the business, to live
// contacts and to 20 hits, the excluded ids are left out, and a failed read is said as a failure, not as "nothing found".
const calls: Array<[string, ...unknown[]]> = [];
let answer: { data: unknown[] | null; error: { message: string } | null } = { data: [], error: null };
function builder() {
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ["select", "eq", "is", "or", "not", "order"]) {
    chain[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return chain;
    };
  }
  chain.limit = async (...args: unknown[]) => {
    calls.push(["limit", ...args]);
    return answer;
  };
  return chain;
}
vi.mock("@/lib/action-context", () => ({
  actionContext: async (orgId: string) =>
    orgId === ORG
      ? {
          ok: true,
          supabase: {
            from: (table: string) => {
              calls.push(["from", table]);
              return builder();
            },
          },
        }
      : { ok: false, message: "לא נמצא." },
}));

describe("searchContactsAction", () => {
  beforeEach(() => {
    calls.length = 0;
    answer = { data: [], error: null };
  });

  it("reads live contacts of the business by name, email or phone, at most 20, leaving out the excluded ids", async () => {
    const { searchContactsAction } = await import("@/features/contacts/picker-actions");
    answer = { data: [{ id: A, full_name: "דנה", email: null, phone: "050-1234567" }], error: null };
    expect(await searchContactsAction(ORG, "דנה", [B])).toEqual({ hits: [{ id: A, label: "דנה", detail: "050-1234567" }] });
    expect(calls).toContainEqual(["from", "contacts"]);
    expect(calls).toContainEqual(["eq", "organization_id", ORG]);
    expect(calls).toContainEqual(["is", "deleted_at", null]);
    expect(calls).toContainEqual(["not", "id", "in", `(${B})`]);
    expect(calls).toContainEqual(["limit", SEARCH_PICKER_MAX_HITS]);
    const or = calls.find((call) => call[0] === "or");
    expect(or?.[1]).toContain("search_text.like");
  });

  it("finds a phone typed with a leading zero by its international form", async () => {
    const { searchContactsAction } = await import("@/features/contacts/picker-actions");
    await searchContactsAction(ORG, "050-123", []);
    const or = calls.find((call) => call[0] === "or");
    expect(or?.[1]).toContain('phone_e164.ilike."%50123%"');
    expect(calls.some((call) => call[0] === "not")).toBe(false);
  });

  it("sends nothing for a short query or a bad exclude list, and says a failed read", async () => {
    const { searchContactsAction } = await import("@/features/contacts/picker-actions");
    expect(await searchContactsAction(ORG, "ד", [])).toEqual({ hits: [] });
    expect(await searchContactsAction(ORG, "דנה", ["not-an-id"])).toEqual({ hits: [] });
    expect(calls).toEqual([]);
    expect(await searchContactsAction("other", "דנה", [])).toEqual({ error: "לא נמצא." });
    answer = { data: null, error: { message: "boom" } };
    expect(await searchContactsAction(ORG, "דנה", [])).toEqual({ error: "החיפוש נכשל. נסו שוב." });
  });
});
