import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NoteText } from "@/features/activities/components/note-text";
import { notePlainText, parseNote, safeHref, sanitizeNote } from "@/features/activities/markdown";
import { applyFormat } from "@/features/activities/note-format";
import { noteSchema } from "@/features/activities/schema";

const html = (text: string) => renderToStaticMarkup(createElement(NoteText, { text }));

// REC-04: basic rich text in notes, stored as cleaned Markdown and never rendered as HTML.
describe("note formatting (REC-04)", () => {
  it("bold, lists and links become elements", () => {
    expect(parseNote("שלום **עולם**")).toEqual([
      { kind: "paragraph", lines: [[{ kind: "text", text: "שלום " }, { kind: "bold", children: [{ kind: "text", text: "עולם" }] }]] },
    ]);
    expect(parseNote("- אחד\n- שניים\n\n1. ראשון\n2. שני")).toEqual([
      { kind: "bullets", items: [[{ kind: "text", text: "אחד" }], [{ kind: "text", text: "שניים" }]] },
      { kind: "numbers", start: 1, items: [[{ kind: "text", text: "ראשון" }], [{ kind: "text", text: "שני" }]] },
    ]);
    expect(parseNote("[האתר](https://example.com/a?b=1)")).toEqual([
      { kind: "paragraph", lines: [[{ kind: "link", href: "https://example.com/a?b=1", children: [{ kind: "text", text: "האתר" }] }]] },
    ]);
    const out = html("**חשוב**\n- [מייל](mailto:a@b.co)\n- [טלפון](tel:+972501234567)");
    expect(out).toContain('<strong class="font-semibold">חשוב</strong>');
    expect(out).toContain('<a href="mailto:a@b.co" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('href="tel:+972501234567"');
    expect(out).toContain("<ul");
  });

  it("plain text stays as it was, line breaks included", () => {
    expect(html("שורה ראשונה\nשורה שנייה")).toContain("שורה ראשונה<br/>שורה שנייה");
    expect(html("a * b ** c")).toContain("a * b ** c");
    expect(html("\\*\\*לא מודגש\\*\\*")).toContain("**לא מודגש**");
    expect(html("[לא קישור] (https://x.com)")).toContain("[לא קישור] (https://x.com)");
  });

  it("HTML a person types is shown as text, never as markup", () => {
    for (const attack of [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      "<a href=\"javascript:alert(1)\">x</a>",
      "**<svg onload=alert(1)>**",
      "- <iframe src=//evil></iframe>",
      "[<b>x</b>](https://example.com)",
    ]) {
      const out = html(attack);
      expect(out).not.toMatch(/<(script|img|svg|iframe|b)[\s>]/i);
      expect(out).toContain("&lt;");
    }
  });

  it("links: only http(s), mailto and tel; anything else is plain words", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\u0000script:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//evil.example",
      "/relative/path",
      "https://user:pass@evil.example",
      'https://example.com/"onmouseover="alert(1)',
      "https://exa mple.com",
      "mailto:not-an-address",
      "tel:call-me",
      "",
    ]) {
      expect(safeHref(bad), bad).toBeNull();
      const out = html(`[לחצו כאן](${bad})`);
      expect(out, bad).not.toContain("<a ");
      expect(out, bad).not.toMatch(/javascript|vbscript|data:/i);
    }
    // a bidi override is dropped from the note before anything else, so it never reaches an address
    expect(safeHref("https://example.com/\u202Eevil")).toBeNull();
    expect(html("[x](https://example.com/\u202Eevil)")).not.toContain("\u202E");
    expect(safeHref("https://example.com")).toBe("https://example.com/");
    expect(safeHref("www.example.com/x")).toBe("https://www.example.com/x");
    expect(safeHref("HTTP://Example.com")).toBe("http://example.com/");
    expect(safeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(safeHref("tel:050-1234567")).toBe("tel:050-1234567");
  });

  it("every link opens in a new tab without access to this page", () => {
    const out = html("[a](https://a.example) ו-[b](http://b.example)");
    expect(out.match(/<a /g)).toHaveLength(2);
    expect(out.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    expect(out.match(/target="_blank"/g)).toHaveLength(2);
  });

  it("saving drops control characters, bidi overrides and links that are not allowed", () => {
    expect(sanitizeNote("a\u0000b\u202Ec\r\nd\u0007")).toBe("abc\nd");
    expect(sanitizeNote("ראו [כאן](javascript:alert(1)) ו-[שם](https://ok.example)")).toBe("ראו כאן) ו-[שם](https://ok.example)");
    expect(sanitizeNote("**מודגש**\n- פריט")).toBe("**מודגש**\n- פריט");
    // the schema stores the cleaned text, and refuses a note that is empty once cleaned
    expect(noteSchema.safeParse({ type: "note", body: "[x](javascript:void(0))" }).data?.body).toBe("x)");
    expect(noteSchema.safeParse({ type: "note", body: "\u0000\u0001" }).success).toBe(false);
  });

  it("a long or hostile note does not take long to show", () => {
    const started = performance.now();
    parseNote("**".repeat(20000));
    parseNote("[".repeat(20000));
    parseNote("[a](".repeat(5000));
    parseNote("- **x".repeat(5000));
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("a one-line preview has no marks", () => {
    expect(notePlainText("**חשוב:** לחזור\n- [אתר](https://x.example)\n- טלפון")).toBe("חשוב: לחזור אתר, טלפון");
  });
});

describe("formatting buttons (REC-04)", () => {
  it("bold wraps the selection and unwraps it on a second press", () => {
    const once = applyFormat("שלום עולם", 5, 9, "bold");
    expect(once).toEqual({ value: "שלום **עולם**", selectionStart: 7, selectionEnd: 11 });
    expect(applyFormat(once.value, once.selectionStart, once.selectionEnd, "bold")).toEqual({ value: "שלום עולם", selectionStart: 5, selectionEnd: 9 });
    expect(applyFormat("", 0, 0, "bold")).toEqual({ value: "****", selectionStart: 2, selectionEnd: 2 });
  });

  it("lists mark every selected line, and a second press takes the marks away", () => {
    const value = "חלב\nלחם\nביצים";
    const bullets = applyFormat(value, 0, value.length, "bullets");
    expect(bullets.value).toBe("- חלב\n- לחם\n- ביצים");
    expect(applyFormat(bullets.value, 0, bullets.value.length, "bullets").value).toBe(value);
    expect(applyFormat(value, 0, value.length, "numbers").value).toBe("1. חלב\n2. לחם\n3. ביצים");
    expect(applyFormat(bullets.value, 0, bullets.value.length, "numbers").value).toBe("1. חלב\n2. לחם\n3. ביצים");
    // the caret alone marks its own line
    expect(applyFormat("א\nב\nג", 2, 2, "bullets").value).toBe("א\n- ב\nג");
  });

  it("a link keeps the selected words and selects the address to type over", () => {
    const edit = applyFormat("ראו אתר", 4, 7, "link");
    expect(edit.value).toBe("ראו [אתר](https://)");
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe("https://");
    const empty = applyFormat("", 0, 0, "link");
    expect(empty.value.slice(empty.selectionStart, empty.selectionEnd)).toBe("https://");
    expect(parseNote(empty.value.replace("https://", "https://example.com"))[0]).toMatchObject({ kind: "paragraph" });
  });
});
