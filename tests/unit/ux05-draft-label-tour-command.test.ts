import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DRAFT_LABEL, draftLabel, screenHelp, tourSteps } from "@/features/guide/guide";
import { HELP_SCREENS } from "@/features/help/content";
import { HELP_CONTENT } from "@/features/help/content.generated";
import { HelpArticleView, HelpIndex } from "@/features/help/components/help-views";
import type { HelpArticle } from "@/features/help/types";
import { DEFAULT_MODULES } from "@/features/modules/modules";
import { matchCommands } from "@/features/search/command-match";
import { buildCommands, type CommandAccess } from "@/features/search/commands";
import { settingsAccessFor } from "@/features/settings/sections";
import { DEFAULT_TERMS } from "@/features/terminology/terms";
import { paths } from "@/lib/paths";

// UX-05 follow-ups, owner's answers of 10 November 2026: (203) ב a visible "טיוטה" label on help texts still marked
// draft; (206) ב "סיור במערכת" in the command palette too.

const ORG = "11111111-1111-4111-8111-111111111111";

const article = (draft: boolean): HelpArticle => ({
  slug: "x",
  category: "start",
  title: "מאמר",
  summary: "תקציר",
  body: [{ p: "טקסט" }],
  ...(draft ? { draft: true } : {}),
});

describe("UX-05 (203) the draft label", () => {
  it("is a word, shown only for a text marked draft", () => {
    expect(DRAFT_LABEL).toBe("טיוטה");
    expect(draftLabel(true)).toBe("טיוטה");
    expect(draftLabel(false)).toBeNull();
    expect(draftLabel(undefined)).toBeNull();
  });

  it("the \"?\" help and the tour steps carry their file's draft mark", () => {
    for (const screen of HELP_SCREENS) {
      const source = HELP_CONTENT.screens.find((s) => s.screen === screen)!;
      expect(screenHelp(screen, DEFAULT_TERMS).draft, screen).toBe(source.draft);
    }
    const rewritten = HELP_CONTENT.screens.map((s) => ({ ...s, draft: false }));
    expect(screenHelp("leads", DEFAULT_TERMS, rewritten).draft).toBe(false);
    const steps = tourSteps(DEFAULT_TERMS, { leads: true });
    expect(steps.map((s) => s.draft)).toEqual(HELP_CONTENT.tour.map((s) => s.draft));
    const clean = tourSteps(DEFAULT_TERMS, { leads: true }, HELP_CONTENT.tour.map((s) => ({ ...s, draft: false })));
    expect(clean.every((s) => draftLabel(s.draft) === null)).toBe(true);
  });

  it("an article shows the label iff it is a draft, on its page and in the index", () => {
    const draft = renderToStaticMarkup(createElement(HelpArticleView, { article: article(true), articles: [article(true)], base: "/b" }));
    const plain = renderToStaticMarkup(createElement(HelpArticleView, { article: article(false), articles: [article(false)], base: "/b" }));
    expect(draft).toContain(">טיוטה<");
    expect(plain).not.toContain("טיוטה");
    expect(renderToStaticMarkup(createElement(HelpIndex, { articles: [article(true)], base: "/b" }))).toContain(">טיוטה<");
    expect(renderToStaticMarkup(createElement(HelpIndex, { articles: [article(false)], base: "/b" }))).not.toContain("טיוטה");
  });

  it("the \"?\" popover and the tour window render the label through the same rule", () => {
    for (const file of ["src/features/guide/components/screen-help-popover.tsx", "src/features/guide/components/guide-tour.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toMatch(/draftLabel\((help|step)\.draft\)/);
      expect(source, file).toContain('<Badge tone="warning">');
    }
  });
});

describe("UX-05 (206) the tour in the command palette", () => {
  const access = (role: "owner" | "viewer"): CommandAccess => ({
    canWrite: role !== "viewer",
    settings: settingsAccessFor({ role, canWrite: role !== "viewer", canDelete: role === "owner", priceLists: false, granted: [] }),
  });

  it("is offered to everyone the account menu offers it to, and opens the tour instead of navigating", () => {
    for (const role of ["owner", "viewer"] as const) {
      const commands = buildCommands(ORG, DEFAULT_TERMS, DEFAULT_MODULES, access(role));
      const tour = commands.find((c) => c.key === "help:tour");
      expect(tour, role).toMatchObject({ group: "help", label: "סיור במערכת", action: "tour", href: paths.orgHelp(ORG) });
      expect(matchCommands(commands, "סיור")[0]?.key, role).toBe("help:tour");
      expect(matchCommands(commands, "הדרכה").map((c) => c.key), role).toContain("help:tour");
    }
  });

  it("the palette fires the same replay event as the account menu", () => {
    const palette = readFileSync("src/features/search/components/global-search.tsx", "utf8");
    const menu = readFileSync("src/features/guide/components/replay-tour-button.tsx", "utf8");
    expect(menu).toContain("window.dispatchEvent(new Event(TOUR_REPLAY_EVENT))");
    expect(palette).toMatch(/item\.action === "tour"\) window\.dispatchEvent\(new Event\(TOUR_REPLAY_EVENT\)\)/);
    // a replay never marks the tour seen: neither opener calls the action
    expect(palette).not.toContain("markGuideTourSeenAction");
    expect(menu).not.toContain("markGuideTourSeenAction");
  });
});
