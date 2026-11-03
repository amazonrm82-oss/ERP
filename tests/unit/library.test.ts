import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_LIBRARY_CATEGORIES } from "@/features/library/categories";
import { libraryFileItemSchema, libraryLinkSchema } from "@/features/library/schema";
import { isLibraryItemOfferable, libraryValidity } from "@/features/library/validity";

// LIB-01: the content library's app rules: the default categories mirror the migration's seed, the validity window, and the
// item form (an https link by the QR link rule, the window ordered).

const migration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20261006021155_content_library.sql"), "utf8");

describe("content library (LIB-01)", () => {
  it("the default categories are the migration's seed, in order", () => {
    const seed = /from \(values ([^;]*?)\) as d\(name, pos\)/.exec(migration)?.[1] ?? "";
    const names = [...seed.matchAll(/\('([^']+)', (\d+)\)/g)].map((m) => [m[1], Number(m[2])] as const);
    expect(names.map(([name]) => name)).toEqual([...DEFAULT_LIBRARY_CATEGORIES]);
    expect(names.map(([, pos]) => pos)).toEqual(DEFAULT_LIBRARY_CATEGORIES.map((_, i) => i));
  });

  it("an item is valid inside its window, both ends included", () => {
    const window = { validFrom: "2026-11-01", validUntil: "2026-11-30" };
    expect(libraryValidity(window, "2026-10-31")).toBe("not_yet");
    expect(libraryValidity(window, "2026-11-01")).toBe("valid");
    expect(libraryValidity(window, "2026-11-30")).toBe("valid");
    expect(libraryValidity(window, "2026-12-01")).toBe("expired");
    expect(libraryValidity({ validFrom: null, validUntil: null }, "2030-01-01")).toBe("valid");
  });

  it("only an active item inside its window is offered", () => {
    expect(isLibraryItemOfferable({ isActive: true, validFrom: null, validUntil: "2026-11-30" }, "2026-11-30")).toBe(true);
    expect(isLibraryItemOfferable({ isActive: true, validFrom: null, validUntil: "2026-11-30" }, "2026-12-01")).toBe(false);
    expect(isLibraryItemOfferable({ isActive: false, validFrom: null, validUntil: null }, "2026-12-01")).toBe(false);
  });

  it("a link is stored as https, with https:// added when typed without a scheme", () => {
    const base = { title: " קטלוג ", description: "", category_id: "", valid_from: "", valid_until: "", is_active: "on" };
    const typed = libraryLinkSchema.safeParse({ ...base, url: "www.example.co.il/catalog" });
    expect(typed.success && typed.data.url).toBe("https://www.example.co.il/catalog");
    expect(typed.success && typed.data.title).toBe("קטלוג");
    for (const url of ["http://example.com", "javascript:alert(1)", "https://user:pw@example.com/", ""]) {
      expect(libraryLinkSchema.safeParse({ ...base, url }).success, url).toBe(false);
    }
  });

  it("the window's end is on or after its start; a file item takes no url", () => {
    const base = { title: "מצגת", description: "", category_id: "", is_active: "" };
    expect(libraryFileItemSchema.safeParse({ ...base, valid_from: "2026-11-02", valid_until: "2026-11-01" }).success).toBe(false);
    const ok = libraryFileItemSchema.safeParse({ ...base, valid_from: "2026-11-01", valid_until: "2026-11-01" });
    expect(ok.success && ok.data.is_active).toBe(false);
    expect(ok.success && "url" in ok.data).toBe(false);
  });
});
