import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { getHelpArticle, HELP_ARTICLES, PUBLIC_HELP_ARTICLES, publicHelpArticles } from "@/features/help/articles";
import { HelpArticleView } from "@/features/help/components/help-views";
import { PublicHelpIndex } from "@/features/help/components/public-help";
import { articleText, type HelpArticle } from "@/features/help/types";
import { isAlwaysLightPath, pageThemeChoice } from "@/features/theme/theme";
import { paths } from "@/lib/paths";

// UX-06: the public help center at /help. Built from docs/help/ (content.generated.ts) like the center inside the app,
// but a draft is never shown publicly (owner 204), and the pages are static: no database, no key, no visitor input.

const read = (path: string) => readFileSync(path, "utf8");
const article = (slug: string, draft?: boolean): HelpArticle => ({
  slug,
  category: "start",
  title: `כותרת ${slug}`,
  summary: `תקציר ${slug}`,
  body: [{ p: `פסקה של ${slug}` }],
  ...(draft === undefined ? {} : { draft }),
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("UX-06 public help center: never a draft", () => {
  it("the public list holds no draft, and every article without a draft flag", () => {
    expect(PUBLIC_HELP_ARTICLES.every((a) => !a.draft)).toBe(true);
    expect(PUBLIC_HELP_ARTICLES.map((a) => a.slug)).toEqual(HELP_ARTICLES.filter((a) => !a.draft).map((a) => a.slug));
  });

  it("the filter keeps only an article with no draft flag or an explicit false", () => {
    const list = [article("a"), article("b", true), article("c", false), { ...article("d"), draft: "yes" as unknown as boolean }];
    expect(publicHelpArticles(list).map((a) => a.slug)).toEqual(["a", "c"]);
  });

  it("a draft article is not found on the public address, and not in the sitemap", () => {
    for (const draft of HELP_ARTICLES.filter((a) => a.draft)) {
      expect(getHelpArticle(draft.slug)).toBeNull();
    }
    // the sitemap and the static params read the public list, never the full one
    expect(read("src/app/sitemap.ts")).toContain("PUBLIC_HELP_ARTICLES.map");
    const slugPage = read("src/app/help/[slug]/page.tsx");
    expect(slugPage).toContain("PUBLIC_HELP_ARTICLES.map");
    expect(slugPage).toContain("dynamicParams = false");
    expect(slugPage).not.toMatch(/drafts:\s*true/);
    expect(read("src/app/help/page.tsx")).not.toMatch(/\bHELP_ARTICLES\b/);
  });

  it("the front page lists only what it is given: a draft passed through the filter never shows", () => {
    const list = publicHelpArticles([article("open"), article("secret", true)]);
    const html = renderToStaticMarkup(createElement(PublicHelpIndex, { articles: list }));
    expect(html).toContain(`href="${paths.helpArticle("open")}"`);
    expect(html).not.toContain("secret");
    expect(html).not.toContain("טיוטה");
  });

  it("with nothing approved yet the page says so honestly and links to the roadmap", () => {
    const html = renderToStaticMarkup(createElement(PublicHelpIndex, { articles: [] }));
    expect(html).toContain("המדריכים עוד בכתיבה");
    expect(html).toContain(`href="${paths.roadmap}"`);
    expect(html).not.toContain('type="search"');
  });

  it("the full front page renders every public article's link and no draft badge", () => {
    const html = renderToStaticMarkup(createElement(PublicHelpIndex, { articles: PUBLIC_HELP_ARTICLES }));
    for (const a of PUBLIC_HELP_ARTICLES) expect(html, a.slug).toContain(`href="${paths.helpArticle(a.slug)}"`);
    expect(html).not.toContain("טיוטה");
    expect(html).toContain(`href="${paths.roadmap}"`);
  });
});

describe("UX-06 public help center: each article renders", () => {
  it.each(PUBLIC_HELP_ARTICLES.map((a) => [a.slug, a] as const))("%s", (_slug, a) => {
    const html = renderToStaticMarkup(createElement(HelpArticleView, { article: a, articles: PUBLIC_HELP_ARTICLES, base: paths.help }));
    expect(html).toContain("<h1");
    // the title and the summary are there (escaped as React escapes them)
    expect(html).toContain(renderToStaticMarkup(createElement("span", null, a.title)).slice(6, -7));
    expect(html).toContain(renderToStaticMarkup(createElement("span", null, a.summary)).slice(6, -7));
    expect(html).not.toContain("טיוטה");
    expect(articleText(a).length).toBeGreaterThan(a.title.length);
    // related links stay inside the public center and point only at public articles
    for (const href of html.matchAll(/href="([^"]+)"/g)) {
      const target = href[1];
      if (target.startsWith(`${paths.help}/`)) expect(getHelpArticle(target.slice(paths.help.length + 1)), target).not.toBeNull();
      expect(target.startsWith("/o/"), target).toBe(false);
    }
  });
});

describe("UX-06 public help center: static and public", () => {
  it("reads no database, uses no key and takes no visitor input", () => {
    const sources = [...files("src/app/help"), ...files("src/features/help")].filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of sources) {
      const text = read(f);
      expect(text, f).not.toMatch(/@\/lib\/supabase|\.rpc\(|\.from\(|service-role|SERVICE_ROLE|createClient|cookies\(|headers\(/);
    }
  });

  it("is reached from the landing page footer and the in-app help center", () => {
    expect(read("src/components/public-shell.tsx")).toMatch(/href=\{paths\.help\}/);
    expect(read("src/app/page.tsx")).toContain("<SiteFooter");
    expect(read("src/app/o/[orgId]/help/page.tsx")).toContain("paths.help}");
  });

  it("follows the viewer's own theme, dark included (owner's answer (239) ב), drawn with design tokens only", () => {
    for (const path of ["/help", "/help/leads", "/help/roadmap"]) {
      expect(isAlwaysLightPath(path), path).toBe(false);
      expect(pageThemeChoice(path, "dark"), path).toBe("dark");
      expect(pageThemeChoice(path, undefined), path).toBe("system");
    }
    // no palette colour, hex/rgb or fixed light/dark class: every colour is a role that has a dark value in globals.css
    const sources = [
      ...files("src/app/help"),
      ...files("src/features/help/components"),
      "src/components/public-shell.tsx",
    ].filter((f) => f.endsWith(".tsx"));
    for (const f of sources) {
      const text = read(f);
      expect(text, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(?:bg|text|border)-(?:white|black|gray|slate|zinc|neutral|stone|red|blue|green|yellow)-?\d*\b|\bdark:/);
    }
  });

  it("is indexable, with a description for search engines", () => {
    expect(read("src/app/help/layout.tsx")).toMatch(/index:\s*true/);
    expect(read("src/app/help/page.tsx")).toMatch(/description:/);
    expect(read("src/app/help/[slug]/page.tsx")).toMatch(/description: article\.summary/);
  });
});
