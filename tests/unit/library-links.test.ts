import { describe, expect, it } from "vitest";

import {
  linkHost,
  publicLibraryFileFrom,
  publicLibraryGoFrom,
  publicLibraryGoPath,
  publicLibraryItemFrom,
  publicLibraryPath,
  publicLibraryFilePath,
  LIBRARY_LINK_TOKEN,
} from "@/features/library-links/public";
import { qrInterstitialHtml } from "@/features/qr-codes/interstitial";
import { qrTargetResponse } from "@/features/qr-codes/scan-server";
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
      externalBlocked: false,
      file: null,
    });
    // BIZ-03's emergency switch: no link and no button, never "malformed"
    const blocked = publicLibraryItemFrom({ ...answer, item: { ...answer.item, url: null, external_blocked: true } });
    expect(blocked).toMatchObject({ kind: "link", url: null, externalBlocked: true });
    // a link the database still sent is dropped while the switch says blocked
    expect(publicLibraryItemFrom({ ...answer, item: { ...answer.item, external_blocked: true } })?.url).toBeNull();
    expect(publicLibraryItemFrom({ ...answer, item: { ...answer.item, external_blocked: false } })?.externalBlocked).toBe(false);
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

describe("LIB-02 (293) ב: a link item goes through the page before the site", () => {
  const go = (data: unknown) => {
    const answer = publicLibraryGoFrom(data);
    if (!answer || answer.kind !== "go") throw new Error("expected the page before the site");
    return answer.view;
  };

  it("keeps the stored link unchanged (no tags added) and names the host and the business", () => {
    expect(publicLibraryGoPath(TOKEN)).toBe(`/f/lib/${TOKEN}/go`);
    expect(go({ url: "https://Shop.Example.co.il/p?x=1#top", business: " נגריית הצפון " })).toEqual({
      href: "https://Shop.Example.co.il/p?x=1#top",
      host: "shop.example.co.il",
      hostUnicode: null,
      business: "נגריית הצפון",
    });
    const html = qrInterstitialHtml(go({ url: "https://shop.example.com/c", business: "נגריית הצפון" }));
    expect(html).toContain('אתם עוברים לאתר <bdi dir="ltr" class="host">shop.example.com</bdi>. <bdi>נגריית הצפון</bdi> אחראי לתוכן שלו.');
    expect(html).toContain('href="https://shop.example.com/c"');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("shows punycode in its own letters only when safe, and escapes everything", () => {
    expect(go({ url: "https://xn--4dbrk0ce.co.il/", business: "עסק" }).hostUnicode).toBe("ישראל.co.il");
    const cyrillic = new URL("https://аррӏе.com/").hostname;
    expect(go({ url: `https://${cyrillic}/`, business: "עסק" }).hostUnicode).toBeNull();
    const html = qrInterstitialHtml(go({ url: 'https://a.io/"><script>alert(1)</script>', business: "<img src=x onerror=alert(1)>" }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>alert");
  });

  it("refuses anything but a stored https link and a business name (an error, never 'not found')", () => {
    expect(publicLibraryGoFrom({ rate_limited: true })).toEqual({ kind: "rate-limited" });
    for (const url of ["http://a.io/", "javascript:alert(1)", "https://user@a.io/", "//a.io", ""]) {
      expect(publicLibraryGoFrom({ url, business: "עסק" }), url).toBeNull();
    }
    expect(publicLibraryGoFrom({ url: "https://a.io/", business: " " })).toBeNull();
    expect(publicLibraryGoFrom({ url: "https://a.io/" })).toBeNull();
    expect(publicLibraryGoFrom(null)).toBeNull();
  });

  it("is never framed, never cached and sends no referrer", () => {
    const response = qrTargetResponse({ kind: "external", ...go({ url: "https://a.io/", business: "עסק" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
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
