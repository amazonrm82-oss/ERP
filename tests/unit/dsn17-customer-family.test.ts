import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicBrandHeader, PublicPageFooter } from "@/features/branding/components/public-page";

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
];

// pages whose own header is the family header (quote, order and statement documents draw their own letterhead)
const HEADER_PAGES = [
  "src/app/f/[token]/page.tsx",
  "src/app/f/[token]/qr/page.tsx",
  "src/app/f/book/[token]/page.tsx",
  "src/app/f/book/manage/[token]/page.tsx",
  "src/app/f/card/[token]/page.tsx",
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

const PDF_BUILDERS = [
  "src/features/quotes/pdf.ts",
  "src/features/orders/pdf.ts",
  "src/features/statements/pdf.ts",
];

describe("DSN-17: the customer pages are one family", () => {
  it.each(CUSTOMER_PAGES)("%s is in the business's colour and ends with the family footer", (file) => {
    const source = read(file);
    expect(source).toContain("<BrandScope");
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
    for (const file of ["src/app/f/quote/[token]/page.tsx", "src/app/f/order/[token]/page.tsx", "src/app/f/statement/[token]/page.tsx"]) {
      const source = read(file);
      // the full page: BrandScope opens right before its <main>, so the answer panel and the buttons take the colour too
      expect(source, file).toMatch(/<BrandScope color=\{page\.color\}>\s*<main className="mx-auto min-h-dvh w-full max-w-4xl/);
    }
    for (const file of ["src/app/f/quote/[token]/page.tsx", "src/app/f/order/[token]/page.tsx"]) {
      // the status page of a closed quote / cancelled order is branded as well
      expect(read(file), file).toMatch(/<BrandScope color=\{page\.color\}>\s*<main className="mx-auto min-h-dvh w-full max-w-md space-y-4/);
    }
  });

  it.each(DOCUMENTS)("%s is a BrandScope with the business's logo", (file) => {
    const source = read(file);
    expect(source).toContain("<BrandScope color={data.color}>");
    expect(source).toMatch(/<OrgLogo\b/);
  });
});

describe("DSN-17: the customer PDFs are the same family", () => {
  it.each(CUSTOMER_PDFS)("$server loads the business's logo for $builder", ({ server, builder }) => {
    const source = read(server);
    expect(source).toContain(builder);
    expect(source).toContain("loadPdfLogo(");
  });

  it.each(PDF_BUILDERS)("%s passes the business's colour and logo to the renderer", (file) => {
    const source = read(file);
    expect(source).toMatch(/color: data\.color,/);
    expect(source).toMatch(/\blogo,/);
  });

  it("the renderer corrects the colour for contrast as BrandScope does", () => {
    expect(read("src/features/pdf/render.ts")).toMatch(/brandPalette\(isHexColor\(doc\.color\) \? doc\.color : DEFAULT_PICKER_COLOR, "light"\)/);
  });
});

describe("DSN-17: the family header and footer", () => {
  it("names the business in the logo's text when the page knows it", () => {
    const html = renderToStaticMarkup(createElement(PublicBrandHeader, { logoUrl: "https://example.com/l.png", business: "העסק", title: "כותרת", subtitle: "שורה" }));
    expect(html).toContain('alt="הלוגו של העסק"');
    expect(html).toContain("<h1");
    expect(html).toContain("כותרת");
    expect(html).toContain("שורה");
  });

  it("draws no image without a logo, and a neutral text when the page does not know the name", () => {
    expect(renderToStaticMarkup(createElement(PublicBrandHeader, { logoUrl: null, business: "העסק", title: "כותרת" }))).not.toContain("<img");
    expect(renderToStaticMarkup(createElement(PublicBrandHeader, { logoUrl: "https://example.com/l.png", business: null, title: "כותרת" }))).toContain('alt="לוגו העסק"');
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
