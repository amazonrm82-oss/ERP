// UX-05: the in-app guide. (א) the first-visit tour, (ב) the "?" help of each main screen. The texts are Markdown in
// docs/help/ (tour/ and screens/), compiled into the help content; this file resolves them on the server, pure and
// unit-tested. Client components import tour.ts only, never this file (it carries the whole help corpus).

import "server-only";

import { HELP_CONTENT } from "@/features/help/content.generated";
import { videoUrlOk, type HelpScreen, type ScreenHelp, type TourStep } from "@/features/help/content";
import type { OrgModules } from "@/features/modules/modules";
import type { OrgTerms, TermForms } from "@/features/terminology/terms";

import type { ResolvedScreenHelp, ResolvedTourStep } from "./tour";

// the state rules live in tour.ts (client-safe); re-exported so server code and tests have one import
export { TOUR_REPLAY_EVENT, tourMarksSeen, tourProgress, tourStartsByItself, tourStepAfter, type ResolvedScreenHelp, type ResolvedTourStep } from "./tour";

const TERM_TOKEN = /\{(lead|deal|contact)\.(singular|plural|theSingular|thePlural|newOne)\}/g;

/** Puts the business's own words (FLD-10) into a guide text: {lead.plural} -> "לידים" or "פניות". */
export function fillTerms(text: string, terms: OrgTerms): string {
  return text.replace(TERM_TOKEN, (_all, kind: keyof OrgTerms, form: keyof Omit<TermForms, "gender">) => terms[kind][form]);
}

/**
 * The tour's steps in the business's words. A step about a screen the business switched off (LEAD-08: leads) is left out,
 * so the tour never points at something the menu does not show.
 */
export function tourSteps(terms: OrgTerms, modules: Pick<OrgModules, "leads">, steps: TourStep[] = HELP_CONTENT.tour): ResolvedTourStep[] {
  return steps.filter((step) => modules.leads || step.screen !== "leads").map((step) => ({ ...step, title: fillTerms(step.title, terms), body: step.body.map((p) => fillTerms(p, terms)) }));
}

/** The "?" help of one screen, in the business's words. The video link shows only when a real https address is set. */
export function screenHelp(screen: HelpScreen, terms: OrgTerms, screens: ScreenHelp[] = HELP_CONTENT.screens): ResolvedScreenHelp {
  const help = screens.find((s) => s.screen === screen);
  if (!help) throw new Error(`no help for screen ${screen}`);
  const [a, b, c] = help.lines;
  return {
    title: fillTerms(help.title, terms),
    lines: [fillTerms(a, terms), fillTerms(b, terms), fillTerms(c, terms)],
    article: help.article,
    video: help.video && videoUrlOk(help.video) ? help.video : null,
  };
}
