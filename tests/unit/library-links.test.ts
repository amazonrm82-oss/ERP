import { describe, expect, it } from "vitest";

import { linkHost, publicLibraryFileFrom, publicLibraryItemFrom, publicLibraryPath, publicLibraryFilePath, LIBRARY_LINK_TOKEN } from "@/features/library-links/public";
import { isLibraryRecordKind } from "@/features/library-links/record";
import { libraryLinkMessage, libraryMailtoHref, libraryWhatsappHref } from "@/features/library-links/share";
import { viewsText } from "@/features/library-links/texts";

// LIB-02: the pure parts of a library item sent by a tracked link (the database side is tests/db/339-library-links)

const TOKEN = "A".repeat(64);

describe("LIB-02: the customer's page answer", () => {
  const answer = {
    business: "נגריית הצפון",
    brand: { logo: null, color: "#336699" },
    built_with: true,
    item: { kind: "link", title: "קטלוג", description: null, url: "https://example.com/c", file: null },
  };

  it("shapes a link item and a file item", () => {
    expect(publicLibraryItemFrom(answer)).toEqual({
      business: "נגריית הצפון",
      logoPath: null,
      color: "#336699",
      builtWith: true,
      kind: "link",
      title: "קטלוג",
      description: null,
      url: "https://example.com/c",
      file: null,
    });
    const file = { ...answer, item: { kind: "file", title: "מצגת", description: "x", url: null, file: { name: "a.pdf", mime_type: "application/pdf", size_bytes: 12 } } };
    expect(publicLibraryItemFrom(file)?.file).toEqual({ name: "a.pdf", mimeType: "application/pdf", sizeBytes: 12 });
  });

  it("refuses a malformed answer (an error, never 'not found')", () => {
    expect(publicLibraryItemFrom(null)).toBeNull();
    expect(publicLibraryItemFrom({ ...answer, item: { ...answer.item, url: null } })).toBeNull();
    expect(publicLibraryItemFrom({ ...answer, item: { ...answer.item, kind: "file" } })).toBeNull();
    expect(publicLibraryItemFrom({ ...answer, business: 3 })).toBeNull();
  });

  it("reads the file answer", () => {
    expect(publicLibraryFileFrom({ rate_limited: true })).toEqual({ kind: "rate-limited" });
    expect(publicLibraryFileFrom({ path: "o/f", name: "a.pdf", mime_type: "application/pdf" })).toEqual({ kind: "file", path: "o/f", name: "a.pdf", mimeType: "application/pdf" });
    expect(publicLibraryFileFrom({ path: "", name: "a", mime_type: "x" })).toBeNull();
  });

  it("paths, the token and the record kinds", () => {
    expect(LIBRARY_LINK_TOKEN.test(TOKEN)).toBe(true);
    expect(LIBRARY_LINK_TOKEN.test("A".repeat(63))).toBe(false);
    expect(publicLibraryPath(TOKEN)).toBe(`/f/lib/${TOKEN}`);
    expect(publicLibraryFilePath(TOKEN)).toBe(`/api/forms/lib/${TOKEN}/file`);
    expect(linkHost("https://shop.example.com/a?b=1")).toBe("shop.example.com");
    expect(linkHost("not a url")).toBeNull();
    expect(["lead", "contact", "company", "deal"].every(isLibraryRecordKind)).toBe(true);
    expect(isLibraryRecordKind("task")).toBe(false);
  });
});

describe("LIB-02: the card", () => {
  it("says how often the customer opened the link", () => {
    expect(viewsText(0, "")).toBe("עוד לא נפתח");
    expect(viewsText(1, "1.11.2026")).toBe("נפתח פעם אחת, ב-1.11.2026");
    expect(viewsText(4, "2.11.2026")).toBe("נפתח 4 פעמים, לאחרונה ב-2.11.2026");
  });

  it("builds the messages, leaving out what is missing and anything that could add mail headers", () => {
    const url = `https://app.example.com/f/lib/${TOKEN}`;
    expect(libraryLinkMessage(url, "קטלוג", "נגריה", "דנה")).toBe(`שלום דנה, כאן נגריה. קטלוג נמצא בקישור הזה: ${url}`);
    expect(libraryLinkMessage(url, "קטלוג", null, null)).toBe(`שלום, קטלוג נמצא בקישור הזה: ${url}`);
    expect(libraryWhatsappHref(url, "קטלוג", null, null, "+972501234567")).toMatch(/^https:\/\/wa\.me\/972501234567\?text=/);
    expect(libraryWhatsappHref(url, "קטלוג", null, null, "0501234567")).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(libraryMailtoHref(url, "קטלוג", "נגריה", null, "dana@example.com")).toMatch(/^mailto:dana@example\.com\?subject=/);
    expect(libraryMailtoHref(url, "קטלוג", "נגריה", null, "a@b.com?bcc=x@y.com")).toMatch(/^mailto:\?subject=/);
  });
});
