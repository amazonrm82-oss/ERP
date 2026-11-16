import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import { MAIN_CONTENT_ID, SkipLink } from "@/components/skip-link";
import { contactErrorInput } from "@/features/landing/contact";
import { getLegalDocument } from "@/features/legal/documents";
import { SUPPORT } from "@/lib/support";
import { updateSession } from "@/lib/supabase/proxy";

// WEB-04: the public site at WCAG 2.0 AA (IS 5568), the accessibility statement, and no cookie banner because nothing tracks.

const read = (path: string) => readFileSync(path, "utf8");
const LANDING = "src/features/landing/components";

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, ext) : ext.test(path) ? [path] : [];
  });
}

describe("skip link (WCAG 2.4.1)", () => {
  it("goes to the page's main content and is hidden until the keyboard reaches it", () => {
    const html = renderToStaticMarkup(SkipLink());
    expect(html).toContain(`href="#${MAIN_CONTENT_ID}"`);
    expect(html).toContain("דילוג לתוכן");
    expect(html).toMatch(/class="sr-only focus:not-sr-only /);
  });

  it("is the first thing in every public page's frame, and every one of their <main> is its target", () => {
    const nav = read(`${LANDING}/sections.tsx`);
    expect(nav).toMatch(/<header className=\{styles\.nav\}>\s*(\{\/\*[^]*?\*\/\}\s*)?<SkipLink \/>/);
    const shell = read("src/components/public-shell.tsx");
    expect(shell).toMatch(/<div className="flex min-h-dvh flex-col bg-surface">\s*<SkipLink \/>/);
    for (const page of ["src/app/page.tsx", "src/app/features/page.tsx", `${LANDING}/industry-page.tsx`, "src/components/public-shell.tsx"]) {
      expect(read(page), page).toMatch(/<main id=\{MAIN_CONTENT_ID\}/);
    }
  });
});

describe("motion (WCAG 2.2.2, prefers-reduced-motion)", () => {
  const css = read(`${LANDING}/landing.module.css`);
  const reduceBlock = (() => {
    const at = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf("{", at); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) return css.slice(at, i);
    }
    return "";
  })();

  it("every endless CSS animation of the landing pages stops under reduced motion", () => {
    const endless = [...css.matchAll(/([^{}]+)\{[^{}]*animation:[^;{}]*infinite[^{}]*\}/g)].flatMap((m) => [...m[1].matchAll(/\.([A-Za-z][\w-]*)/g)].map((c) => c[1]));
    expect(endless.length).toBeGreaterThan(3);
    for (const name of new Set(endless)) expect(reduceBlock, name).toMatch(new RegExp(`\\.${name}\\b`));
    expect(reduceBlock).toMatch(/animation: none/);
  });

  it("the hero canvas draws one still frame, the SVG animations pause and the pause button steps aside", () => {
    expect(read(`${LANDING}/hero-canvas.tsx`)).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    const pause = read(`${LANDING}/pause-button.tsx`);
    expect(pause).toMatch(/if \(query\.matches\) setSvgs\(true\)/);
    expect(pause).toMatch(/if \(reduced\) return null;/);
    expect(read(`${LANDING}/rot-word.tsx`)).toContain("prefers-reduced-motion: reduce");
  });

  it("the industry pages, whose closing section moves, carry the pause button and the root it stops", () => {
    const page = read(`${LANDING}/industry-page.tsx`);
    expect(page).toContain("<PauseButton />");
    expect(page).toMatch(/<div id=\{LANDING_ROOT_ID\} className=\{styles\.page\} data-paused="false">/);
  });
});

describe("form errors are tied to their field (WCAG 3.3.1, 1.3.1)", () => {
  it("the contact form's refusal names the input that gets aria-invalid, aria-describedby and the focus", () => {
    expect(contactErrorInput({ ok: false, field: "full_name" })).toBe("name");
    expect(contactErrorInput({ ok: false, field: "phone" })).toBe("phone");
    expect(contactErrorInput({ ok: false, field: "consent" })).toBe("consent");
    expect(contactErrorInput({ ok: false, field: "business_type" })).toBe("business_type");
    expect(contactErrorInput({ ok: false, field: "cf-turnstile-response" })).toBeNull();
    expect(contactErrorInput({ ok: false, field: "constructor" })).toBeNull();
    expect(contactErrorInput({ ok: true, field: "phone" })).toBeNull();
    expect(contactErrorInput(null)).toBeNull();
    const form = read(`${LANDING}/contact-form.tsx`);
    expect(form).toMatch(/"aria-describedby": errorId/);
    expect(form).toMatch(/<p id=\{errorId\} role="alert"/);
  });

  it("the notify-me form takes the focus when it opens and ties its message to the field", () => {
    const cards = read(`${LANDING}/price-cards.tsx`);
    expect(cards).toMatch(/emailRef\)\.current\?\.focus\(\)/);
    expect(cards).toMatch(/<p id=\{`\$\{id\}-error`\} role="alert"/);
  });
});

describe("no cookie banner: the public site sets no cookie and keeps nothing in the browser", () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  });

  it("the proxy answers an anonymous visitor of every public page without Set-Cookie", async () => {
    for (const path of ["/", "/features", "/industries/clinic", "/industries/studio", "/help", "/help/roadmap", "/legal/accessibility", "/login", "/signup", "/forgot-password", "/?utm_source=facebook"]) {
      const response = await updateSession(new NextRequest(`https://mexuzsystem.com${path}`));
      expect(response.headers.get("set-cookie"), path).toBeNull();
      expect(response.cookies.getAll(), path).toEqual([]);
      expect(response.status, path).toBe(200);
    }
  });

  it("no code of the public pages writes a cookie or browser storage", () => {
    const sources = [...files("src/features/landing", /\.tsx?$/), ...files("src/app/industries", /\.tsx$/), ...files("src/app/help", /\.tsx$/), ...files("src/app/legal", /\.tsx$/), "src/app/page.tsx", "src/app/features/page.tsx", "src/components/public-shell.tsx"];
    for (const file of sources) {
      const code = read(file);
      expect(code, file).not.toMatch(/document\.cookie|localStorage|sessionStorage|indexedDB|cookies\(\)\.set|\.cookies\.set\(/);
    }
  });
});

describe("the accessibility statement (IS 5568)", () => {
  const doc = getLegalDocument("accessibility");

  it("is a draft with what was checked, the known limits, the coordinator's contact and the date of its version", () => {
    expect(doc).not.toBeNull();
    if (!doc) return;
    expect(doc.interim).toBe(true);
    const headings = doc.sections.map((s) => s.heading);
    expect(headings).toEqual(["המחויבות שלנו", "מה עשינו", "איך זה נבדק", "מגבלות ידועות", "רכז הנגישות", "עדכון ההצהרה"]);
    const coordinator = doc.sections.find((s) => s.heading === "רכז הנגישות")?.paragraphs.join("\n") ?? "";
    expect(coordinator).toContain(SUPPORT.phone);
    expect(coordinator).toMatch(/אימייל: \S+@\S+/);
    // the date in the text is the version's date
    const [y, m, d] = doc.version.split("-").map(Number);
    const months = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
    expect(doc.sections.at(-1)?.paragraphs[0]).toBe(`ההצהרה עודכנה ב-${d} ב${months[m - 1]} ${y}.`);
  });
});
