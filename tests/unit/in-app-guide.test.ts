import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { fillTerms, screenHelp, tourMarksSeen, tourProgress, tourStartsByItself, tourStepAfter, tourSteps } from "@/features/guide/guide";
import { frameProfileFrom } from "@/features/profile/frame-fields";
import { getHelpArticle, HELP_ARTICLES, PUBLIC_HELP_ARTICLES } from "@/features/help/articles";
import {
  blocksToMarkdown,
  buildHelpContent,
  HELP_SCREENS,
  HelpContentError,
  parseBlocks,
  renderGeneratedModule,
  splitFrontmatter,
  TOUR_LENGTH,
  videoUrlOk,
  type HelpSourceFile,
} from "@/features/help/content";
import { HELP_CONTENT } from "@/features/help/content.generated";
import { helpFold, queryWords, searchHelp } from "@/features/help/search";
import { articleText } from "@/features/help/types";
import { DEFAULT_TERMS, resolveTerms } from "@/features/terminology/terms";
import { searchNorm } from "@/lib/search-norm";

const HELP_DIR = "docs/help";

function helpFiles(dir = HELP_DIR): HelpSourceFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return helpFiles(path);
    if (!entry.name.endsWith(".md")) return [];
    return [{ path: relative(HELP_DIR, path).split(sep).join("/"), source: readFileSync(path, "utf8") }];
  });
}

const fm = (meta: Record<string, string>, body: string) => `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;

describe("UX-05 help content: docs/help/ is the one source", () => {
  it("content.generated.ts is current (run node scripts/build-help-content.mjs after a change under docs/help/)", () => {
    const built = buildHelpContent(helpFiles());
    expect(HELP_CONTENT).toEqual(built);
    expect(readFileSync("src/features/help/content.generated.ts", "utf8")).toBe(renderGeneratedModule(built));
  });

  it("the public center keeps every article it had (28) and never shows a draft", () => {
    expect(PUBLIC_HELP_ARTICLES.length).toBeGreaterThanOrEqual(28);
    expect(PUBLIC_HELP_ARTICLES.every((a) => !a.draft)).toBe(true);
    for (const slug of ["getting-started", "my-day", "leads", "deals", "tasks", "contacts-companies", "reports", "customize", "plan-limits"]) {
      expect(getHelpArticle(slug)?.slug, slug).toBe(slug);
    }
    const draft = HELP_ARTICLES.find((a) => a.draft);
    if (draft) {
      expect(getHelpArticle(draft.slug)).toBeNull();
      expect(getHelpArticle(draft.slug, { drafts: true })?.slug).toBe(draft.slug);
    }
  });

  it("every article file round-trips through the Markdown subset", () => {
    for (const article of HELP_CONTENT.articles) {
      expect(parseBlocks(blocksToMarkdown(article.body), article.slug)).toEqual(article.body);
    }
  });

  it("articles are ordered by topic, then order", () => {
    const topics = ["start", "daily", "intake", "data", "admin", "security"];
    const indexes = HELP_CONTENT.articles.map((a) => topics.indexOf(a.category));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(HELP_CONTENT.articles[0].slug).toBe("getting-started");
  });
});

describe("UX-05 Markdown subset and frontmatter", () => {
  it("reads frontmatter, skips comments, and maps every block kind", () => {
    const { meta, body } = splitFrontmatter(fm({ "# a comment": "", title: '"כותרת"', topic: "start" }, "x"), "f.md");
    expect(meta).toEqual({ title: "כותרת", topic: "start" });
    expect(body.trim()).toBe("x");
    const blocks = parseBlocks("פסקה\nשממשיכה\n\n## כותרת\n\n1. א\n2. **ב**\n\n- ג\n- ד\n\n> הערה\n> שנייה", "f.md");
    expect(blocks).toEqual([{ p: "פסקה שממשיכה" }, { h: "כותרת" }, { steps: ["א", "**ב**"] }, { list: ["ג", "ד"] }, { note: "הערה שנייה" }]);
  });

  it("refuses raw HTML and any Markdown outside the subset", () => {
    for (const body of ["<b>x</b>", "a <script>", "[קישור](https://x.test)", "![תמונה](x.png)", "`code`", "### עמוק", "| a | b |", "**לא סגור", "1. א\n3. ג", "פסקה\n- רשימה"]) {
      expect(() => parseBlocks(body, "f.md"), body).toThrow(HelpContentError);
    }
  });

  it("refuses a file without frontmatter, an unknown key and a missing required one", () => {
    expect(() => splitFrontmatter("no frontmatter", "f.md")).toThrow(HelpContentError);
    const base = [
      ...HELP_SCREENS.map((s) => ({ path: `screens/${s}.md`, source: fm({ title: "t", article: "a" }, "- 1\n- 2\n- 3") })),
      ...[1, 2, 3, 4, 5].map((n) => ({ path: `tour/${n}-s${n}.md`, source: fm({ title: "t", order: String(n) }, "פסקה") })),
    ];
    const ok = { path: "articles/a.md", source: fm({ title: "t", topic: "start", order: "1", summary: "s" }, "גוף") };
    expect(buildHelpContent([...base, ok]).articles).toHaveLength(1);
    expect(() => buildHelpContent([...base, { ...ok, source: fm({ title: "t", topic: "start", order: "1", summary: "s", colour: "x" }, "גוף") }])).toThrow(/unknown frontmatter key/);
    expect(() => buildHelpContent([...base, { ...ok, source: fm({ title: "t", topic: "start", order: "1" }, "גוף") }])).toThrow(/"summary" is required/);
    expect(() => buildHelpContent([...base, { ...ok, source: fm({ title: "t", topic: "nope", order: "1", summary: "s" }, "גוף") }])).toThrow(/unknown topic/);
    expect(() => buildHelpContent([...base, ok, { path: "articles/Bad Name.md", source: ok.source }])).toThrow(HelpContentError);
    expect(() => buildHelpContent([...base, ok, { path: "other/x.md", source: ok.source }])).toThrow(HelpContentError);
    // the tour has exactly five steps, and every screen's help leads to an existing article
    expect(() => buildHelpContent([...base.slice(0, -1), ok])).toThrow(/must have 5/);
    expect(() => buildHelpContent(base)).toThrow(/does not exist/);
    // a screen's help is exactly three lines; a word token must be a known one; a video is an https address
    const leads = base.findIndex((f) => f.path === "screens/leads.md");
    const withLeads = (source: string) => buildHelpContent([...base.map((f, i) => (i === leads ? { ...f, source } : f)), ok]);
    expect(() => withLeads(fm({ title: "t", article: "a" }, "- 1\n- 2"))).toThrow(/exactly three/);
    expect(() => withLeads(fm({ title: "{lead.colour}", article: "a" }, "- 1\n- 2\n- 3"))).toThrow(/unknown word token/);
    expect(() => withLeads(fm({ title: "t", article: "a", video: "http://x.test/v" }, "- 1\n- 2\n- 3"))).toThrow(/https/);
    expect(withLeads(fm({ title: "t", article: "a", video: "https://youtu.be/abc" }, "- 1\n- 2\n- 3")).screens[1].video).toBe("https://youtu.be/abc");
  });

  it("the shipped content holds what UX-05 asks: five tour steps and three lines for each main screen", () => {
    expect(HELP_CONTENT.tour).toHaveLength(TOUR_LENGTH);
    expect(HELP_CONTENT.tour.map((s) => s.screen)).toEqual(["leads", "deals", "tasks", "home", "settings"]);
    expect(HELP_CONTENT.screens.map((s) => s.screen)).toEqual([...HELP_SCREENS]);
    for (const screen of HELP_CONTENT.screens) {
      expect(screen.lines).toHaveLength(3);
      expect(HELP_ARTICLES.some((a) => a.slug === screen.article), screen.screen).toBe(true);
    }
    // UX-07 is not built: no screen has a video yet
    expect(HELP_CONTENT.screens.every((s) => s.video === null)).toBe(true);
  });

  it("every help file's frontmatter has its kind's required fields, filled in, and nothing else", () => {
    const kinds: Record<string, { required: string[]; optional: string[] }> = {
      articles: { required: ["title", "topic", "order", "summary"], optional: ["draft"] },
      screens: { required: ["title", "article"], optional: ["video", "draft"] },
      tour: { required: ["title", "order"], optional: ["screen", "draft"] },
    };
    const files = helpFiles();
    expect(files.length).toBeGreaterThanOrEqual(28 + HELP_SCREENS.length + TOUR_LENGTH);
    for (const file of files) {
      const kind = kinds[file.path.split("/")[0]];
      expect(kind, file.path).toBeDefined();
      const { meta } = splitFrontmatter(file.source, file.path);
      for (const key of kind.required) {
        expect(typeof meta[key], `${file.path}: ${key}`).toBe("string");
        expect(meta[key].trim().length, `${file.path}: ${key}`).toBeGreaterThan(0);
      }
      for (const key of Object.keys(meta)) expect([...kind.required, ...kind.optional], `${file.path}: ${key}`).toContain(key);
      if ("order" in meta) expect(meta.order, file.path).toMatch(/^\d{1,3}$/);
      if ("draft" in meta) expect(["true", "false"], file.path).toContain(meta.draft);
    }
  });

  it("every text Claude Code wrote as a placeholder is marked draft in its file", () => {
    for (const file of helpFiles().filter((f) => f.path.startsWith("screens/") || f.path.startsWith("tour/"))) {
      expect(file.source, file.path).toMatch(/^draft: true$/m);
      expect(file.source, file.path).toMatch(/DRAFT by Claude Code/);
    }
  });
});

describe("UX-05 tour state", () => {
  it("opens by itself only for someone who never saw it, never in a support session or on the setup wizard", () => {
    expect(tourStartsByItself({ seenAt: null, support: false, pathname: "/o/1/leads" })).toBe(true);
    expect(tourStartsByItself({ seenAt: null, support: false, pathname: "/o/1" })).toBe(true);
    expect(tourStartsByItself({ seenAt: "2026-11-10T08:00:00Z", support: false, pathname: "/o/1" })).toBe(false);
    // a failed read answers "seen" (the queries module returns a non-null marker)
    expect(tourStartsByItself({ seenAt: "unknown", support: false, pathname: "/o/1" })).toBe(false);
    expect(tourStartsByItself({ seenAt: null, support: true, pathname: "/o/1" })).toBe(false);
    expect(tourStartsByItself({ seenAt: null, support: false, pathname: "/o/1/setup" })).toBe(false);
    expect(tourStartsByItself({ seenAt: null, support: false, pathname: "/o/1/setup/2" })).toBe(false);
    expect(tourStartsByItself({ seenAt: null, support: false, pathname: "/o/1/settings/setup-x" })).toBe(true);
    expect(tourMarksSeen(true)).toBe(false);
    expect(tourMarksSeen(false)).toBe(true);
  });

  it("moves between steps inside the tour and ends after the last", () => {
    expect(tourStepAfter(0, 1, 5)).toBe(1);
    expect(tourStepAfter(3, 1, 5)).toBe(4);
    expect(tourStepAfter(4, 1, 5)).toBeNull();
    expect(tourStepAfter(2, -1, 5)).toBe(1);
    expect(tourStepAfter(0, -1, 5)).toBe(0);
    expect(tourProgress(1, 5)).toBe("שלב 2 מתוך 5");
  });

  it("speaks in the business's own words (FLD-10)", () => {
    const inquiries = resolveTerms({ contact: "customer", lead: "inquiry", deal: "case" });
    expect(fillTerms("ה{lead.plural} וה{deal.plural} של {contact.plural}", inquiries)).toBe("הפניות והתיקים של לקוחות");
    expect(fillTerms("{lead.plural}", DEFAULT_TERMS)).toBe("לידים");
    const steps = tourSteps(inquiries, { leads: true });
    expect(steps[0].title).toBe("פניות");
    expect(steps[1].title).toBe("לוח תיקים");
    expect(steps.flatMap((s) => [s.title, ...s.body]).some((t) => /[{}]/.test(t))).toBe(false);
  });

  it("leaves out the leads step while the leads module is off (LEAD-08)", () => {
    const on = tourSteps(DEFAULT_TERMS, { leads: true });
    expect(on.map((s) => s.screen)).toEqual(["leads", "deals", "tasks", "home", "settings"]);
    const off = tourSteps(DEFAULT_TERMS, { leads: false });
    expect(off.map((s) => s.screen)).toEqual(["deals", "tasks", "home", "settings"]);
    expect(tourProgress(0, off.length)).toBe("שלב 1 מתוך 4");
  });
});

describe("UX-05 the \"?\" help of each main screen", () => {
  it("gives three lines in the business's words and the article it leads to", () => {
    const terms = resolveTerms({ contact: "patient", lead: "inquiry", deal: "deal" });
    for (const screen of HELP_SCREENS) {
      const help = screenHelp(screen, terms);
      expect(help.lines).toHaveLength(3);
      expect([help.title, ...help.lines].some((t) => /[{}]/.test(t)), screen).toBe(false);
      expect(getHelpArticle(help.article, { drafts: true }), screen).not.toBeNull();
    }
    expect(screenHelp("leads", terms).title).toBe("פניות");
    expect(screenHelp("contacts", terms).title).toBe("מטופלים");
    expect(screenHelp("home", DEFAULT_TERMS).article).toBe("my-day");
  });

  it("shows a video link only for a plain https address", () => {
    const base = HELP_CONTENT.screens.map((s) => (s.screen === "tasks" ? { ...s, video: "https://youtu.be/x1" } : s));
    expect(screenHelp("tasks", DEFAULT_TERMS, base).video).toBe("https://youtu.be/x1");
    expect(screenHelp("leads", DEFAULT_TERMS, base).video).toBeNull();
    const bad = HELP_CONTENT.screens.map((s) => (s.screen === "tasks" ? { ...s, video: "javascript:alert(1)" } : s));
    expect(screenHelp("tasks", DEFAULT_TERMS, bad).video).toBeNull();
    for (const url of ["http://x.test", "https://user:pw@x.test", "javascript:alert(1)", "not a url"]) expect(videoUrlOk(url), url).toBe(false);
    expect(videoUrlOk("https://www.youtube.com/watch?v=abc")).toBe(true);
  });

  it("every main screen's page puts the \"?\" button in its header", () => {
    const pages: Record<string, string> = {
      home: "src/app/o/[orgId]/page.tsx",
      leads: "src/app/o/[orgId]/leads/page.tsx",
      contacts: "src/app/o/[orgId]/contacts/page.tsx",
      deals: "src/app/o/[orgId]/deals/page.tsx",
      tasks: "src/app/o/[orgId]/tasks/page.tsx",
      reports: "src/app/o/[orgId]/reports/page.tsx",
      settings: "src/app/o/[orgId]/settings/page.tsx",
    };
    expect(Object.keys(pages).sort()).toEqual([...HELP_SCREENS].sort());
    for (const [screen, file] of Object.entries(pages)) {
      expect(readFileSync(file, "utf8"), file).toContain(`<ScreenHelp orgId={orgId} screen="${screen}" />`);
    }
  });
});

describe("UX-05 Hebrew search in the help center", () => {
  const entries = HELP_ARTICLES.map((a) => ({ slug: a.slug, title: a.title, summary: a.summary, text: articleText(a) }));

  it("folds like every other search (searchNorm), plus a typed backtick", () => {
    for (const s of ["לִידִים", "מיזוג כפולים", "ד\"ר", "ע׳", "ךםןףץ", "ABC"]) expect(helpFold(s)).toBe(searchNorm(s));
    expect(helpFold("ג`ורג'")).toBe("גורג");
    expect(queryWords("  לִידִים   חדשים ")).toEqual(["לידימ", "חדשימ"]);
    expect(queryWords("   ")).toEqual([]);
  });

  it("finds an article with niqqud, final letters and several words, and nothing for nothing", () => {
    expect(searchHelp(entries, "").length).toBe(0);
    expect(searchHelp(entries, "יִיבּוּא").map((r) => r.slug)).toContain("import");
    expect(searchHelp(entries, "ייבוא אקסל")[0].slug).toBe("import");
    // "לידים" typed with a regular mem finds the word written with a final one
    expect(searchHelp(entries, "לידימ").map((r) => r.slug)).toContain("leads");
    expect(searchHelp(entries, "מילהשלאקיימתבשוםמקום")).toEqual([]);
  });

  it("puts title matches first", () => {
    const results = searchHelp(entries, "משימות");
    expect(results[0].title).toContain("משימות");
  });
});

describe("UX-05 the help content stays on the server", () => {
  // every module a "use client" file reaches through value imports (type-only imports are erased and do not count)
  const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
  function resolveModule(from: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith("@/")) base = join("src", spec.slice(2));
    else if (spec.startsWith(".")) base = join(from, "..", spec);
    else return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  }
  function reach(start: string): Set<string> {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const next = resolveModule(file, match[1]);
        if (next) queue.push(next);
      }
    }
    return seen;
  }
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    });
  }

  it("no client component reaches content.generated.ts, so the help corpus is never in the browser bundle", () => {
    const corpus = join("src", "features", "help", "content.generated.ts");
    const clients = sourceFiles("src").filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    expect(clients.some((f) => f.includes(join("features", "guide")))).toBe(true);
    for (const client of clients) expect(reach(client).has(corpus), client).toBe(false);
    // and the walk does see the corpus where it is imported
    expect(reach(join("src", "features", "guide", "guide.ts")).has(corpus)).toBe(true);
  });
});

describe("UX-05 the business frame reads the profile once", () => {
  it("takes the theme, the what's new dot and the tour from one row, each failing to its safe side", () => {
    expect(frameProfileFrom({ theme: "dark", whats_new_seen_on: "2000-01-01", guide_tour_seen_at: null }, false)).toEqual({
      syncTheme: "dark",
      whatsNewUnread: true,
      tourSeenAt: null,
    });
    expect(frameProfileFrom({ theme: "dark", whats_new_seen_on: null, guide_tour_seen_at: "2026-11-10T00:00:00Z" }, true).syncTheme).toBeNull();
    // a failed read: the theme by the device, no dot, and the tour never pops up by mistake
    expect(frameProfileFrom(null, false)).toEqual({ syncTheme: "system", whatsNewUnread: false, tourSeenAt: "unknown" });
  });

  it("the frame has no other read of profiles", () => {
    const layout = readFileSync(join("src", "app", "o", "[orgId]", "layout.tsx"), "utf8");
    expect(layout).toContain("getFrameProfile(");
    expect(layout).not.toMatch(/from\("profiles"\)/);
  });
});
