import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { logoAlt, PublicBrandHeader, PublicPageFooter } from "@/features/branding/components/public-page";

// DSN-17: the pages a customer sees and the PDF documents are one family: the business's logo and colour (FLD-04), the
// colour corrected for contrast (BrandScope on a page, brandPalette in a PDF), one header and one footer. These checks read
// the sources, so a new customer page or PDF that skips the family fails here.

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

// every page a customer opens through a link of the business (the /f/q interstitial is a plain HTML document of its own,
// and the widget's script is not a page)
const CUSTOMER_PAGES = [
  "src/app/f/[token]/page.tsx",
  "src/app/f/[token]/qr/page.tsx",
  "src/app/f/book/[token]/page.tsx",
  "src/app/f/book/manage/[token]/page.tsx",
  "src/app/f/card/[token]/page.tsx",
  "src/app/f/widget/[token]/page.tsx",
  "src/app/f/quote/[token]/page.tsx",
  "src/app/f/order/[token]/page.tsx",
  "src/app/f/statement/[token]/page.tsx",
  // PRK-02
  "src/app/f/privacy/[token]/page.tsx",
  // CNS-09 / CNS-10
  "src/app/f/prefs/[token]/page.tsx",
  "src/app/f/unsub/[token]/page.tsx",
  // LIB-02
  "src/app/f/lib/[token]/page.tsx",
  // BIZ-01
  "src/app/f/biz/[token]/page.tsx",
  // BIZ-05
  "src/app/f/fill/[token]/page.tsx",
];

// pages whose own header is the family header (quote, order and statement documents draw their own letterhead)
const HEADER_PAGES = [
  "src/app/f/[token]/page.tsx",
  "src/app/f/[token]/qr/page.tsx",
  "src/app/f/book/[token]/page.tsx",
  "src/app/f/book/manage/[token]/page.tsx",
  "src/app/f/card/[token]/page.tsx",
  "src/app/f/privacy/[token]/page.tsx",
  "src/app/f/prefs/[token]/page.tsx",
  "src/app/f/unsub/[token]/page.tsx",
  "src/app/f/lib/[token]/page.tsx",
  "src/app/f/biz/[token]/page.tsx",
  "src/app/f/fill/[token]/page.tsx",
  // the status pages of a closed quote or a cancelled order
  "src/app/f/quote/[token]/page.tsx",
  "src/app/f/order/[token]/page.tsx",
];

// the customer documents drawn inside those pages: each is its own BrandScope with the logo in its letterhead
const DOCUMENTS = [
  "src/features/quotes/components/quote-document.tsx",
  "src/features/orders/components/order-document.tsx",
  "src/features/statements/components/statement-view.tsx",
];

// every PDF a customer receives, and the builder each passes its data to
const CUSTOMER_PDFS: Array<{ server: string; builder: string }> = [
  { server: "src/features/quotes/pdf-server.ts", builder: "quotePdfDocument(" },
  { server: "src/features/quotes/signed-pdf-server.ts", builder: "quoteSignedPdfDocument(" },
  { server: "src/features/orders/pdf-server.ts", builder: "orderPdfDocument(" },
  { server: "src/features/statements/pdf-server.ts", builder: "publicStatementPdfDocument(" },
  { server: "src/features/statements/public-server.ts", builder: "publicStatementPdfDocument(" },
];

// that each builder puts the business's colour and logo into the document is pinned by behaviour, in quote-design,
// quote-signed-pdf, order-pdf and statement-pdf ("DSN-17: ... one of the customer family")

describe("DSN-17: the customer pages are one family", () => {
  it.each(CUSTOMER_PAGES)("%s is in the business's colour and ends with the family footer", (file) => {
    const source = read(file);
    // every BrandScope gets the business's colour from the page's answer, never a fixed null
    const scopes = [...source.matchAll(/<BrandScope color=\{([^}]*)\}/g)].map((m) => m[1].trim());
    expect(scopes.length).toBeGreaterThan(0);
    for (const color of scopes) expect(color, file).toMatch(/^(page|card|widget|found\?)\.(brand\.)?color( \?\? null)?$/);
    expect(source).not.toMatch(/<BrandScope(?![^>]*color=)/);
    expect(source).toContain("<PublicPageFooter");
    // the footer is the only place the "built with" line and the accessibility link are drawn
    expect(source).not.toMatch(/<BuiltWithLine\b/);
    expect(source).not.toMatch(/<AccessibilityLink\b/);
  });

  it.each(HEADER_PAGES)("%s draws its logo only through the family header", (file) => {
    const source = read(file);
    expect(source).toContain("<PublicBrandHeader");
    expect(source).not.toMatch(/<OrgLogo\b/);
  });

  it("every page that shows a business's quote, order or statement wraps the whole page, not only the document", () => {
    const wrapped = (source: string) => [...source.matchAll(/<BrandScope color=\{page\.color\}>\s*<main\b/g)].length;
    // the full page (and for a quote or an order, its status page too): BrandScope opens right around <main>, so the answer
    // panel and the buttons take the colour as well
    expect(wrapped(read("src/app/f/quote/[token]/page.tsx"))).toBe(2);
    expect(wrapped(read("src/app/f/order/[token]/page.tsx"))).toBe(2);
    expect(wrapped(read("src/app/f/statement/[token]/page.tsx"))).toBe(1);
  });

  it.each(DOCUMENTS)("%s is a BrandScope with the business's logo", (file) => {
    const source = read(file);
    expect(source).toMatch(/<BrandScope color=\{data\.color\}>/);
    expect(source).toMatch(/<OrgLogo\b/);
  });
});

describe("DSN-17: the customer PDFs are the same family", () => {
  it.each(CUSTOMER_PDFS)("$server loads the business's logo for $builder", ({ server, builder }) => {
    const source = read(server);
    expect(source).toContain(builder);
    expect(source).toContain("loadPdfLogo(");
  });

  it("the renderer corrects the colour for contrast as BrandScope does", () => {
    expect(read("src/features/pdf/render.ts")).toMatch(/brandPalette\([^)]*doc\.color[^)]*\)/);
  });
});

describe("DSN-17: the family header and footer", () => {
  it("gives the logo no text when the name is written next to it, so a screen reader hears it once", () => {
    const html = renderToStaticMarkup(createElement(PublicBrandHeader, { logoUrl: "https://example.com/l.png", business: "העסק", title: "כותרת", subtitle: "העסק" }));
    expect(html).toContain('alt=""');
    expect(html).toContain("<h1");
    expect(html).toContain("כותרת");
    expect(html).toContain("<h1");
  });

  it("draws no image without a logo, and a neutral text when the page does not know the name", () => {
    expect(renderToStaticMarkup(createElement(PublicBrandHeader, { logoUrl: null, business: "העסק", title: "כותרת" }))).not.toContain("<img");
    expect(renderToStaticMarkup(createElement(PublicBrandHeader, { logoUrl: "https://example.com/l.png", business: null, title: "כותרת" }))).toContain('alt="לוגו העסק"');
    expect(logoAlt("העסק", false)).toBe("הלוגו של העסק");
  });

  it("a page's own logo size replaces the default instead of adding to it", () => {
    const html = renderToStaticMarkup(createElement(PublicBrandHeader, { logoUrl: "https://example.com/l.png", business: null, title: "כותרת", logoClassName: "mb-6 h-16 max-w-56" }));
    expect(html).toContain("h-16");
    expect(html).not.toContain("h-12");
    expect(html).not.toContain("max-w-48");
  });

  it("shows the built-with line only when the plan does, and always the accessibility statement", () => {
    const on = renderToStaticMarkup(createElement(PublicPageFooter, { builtWith: true }));
    const off = renderToStaticMarkup(createElement(PublicPageFooter, { builtWith: false }));
    expect(on).toContain("Mexuz");
    expect(off).not.toContain("Mexuz");
    expect(on).toContain("הצהרת נגישות");
    expect(off).toContain("הצהרת נגישות");
  });
});
