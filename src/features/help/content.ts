// UX-05 / UX-06: turns the Markdown files of docs/help/ into the help center, the "?" help of the main screens and the
// first-visit tour. Pure: scripts/build-help-content.mjs feeds it the files and writes content.generated.ts; the unit test
// does the same and compares. Only type imports and relative .ts imports, so Node can run it with type stripping.
//
// docs/help/articles/<slug>.md   frontmatter: title, topic, order, summary, [draft]      body: the article
// docs/help/screens/<screen>.md  frontmatter: title, article, [video], [draft]           body: one list of exactly 3 lines
// docs/help/tour/<n>-<key>.md    frontmatter: title, order, [screen], [draft]            body: one or two paragraphs
//
// draft: true marks a text Claude Code wrote as a placeholder; the owner rewrites it and removes the line. The public
// center (/help) leaves draft articles out; inside the app they show (the business sees the same words as the owner).
// Screen and tour texts may name the business's own words (FLD-10) with {lead.plural}, {deal.singular} and the like.

import type { HelpArticle, HelpBlock, HelpCategory } from "./types";

// --- The Markdown subset ---
// The Markdown is a small, closed subset that maps onto HelpBlock one to one:
//   a paragraph (lines joined by a space)       -> { p }
//   "## heading"                                 -> { h }
//   lines "1. …", "2. …"                         -> { steps }
//   lines "- …"                                  -> { list }
//   "> …"                                        -> { note }
//   **text** inside any of them names a button, field or screen and is shown bold.
// Raw HTML is refused (the renderer prints text only, but a tag in the source is a mistake to catch early), and so is any
// other Markdown (links, images, code, tables, deeper headings): the parser throws with the file and line.
//
// A file starts with frontmatter between "---" lines, flat "key: value" pairs only, from a closed list per kind.

export type Frontmatter = Record<string, string>;

export class HelpContentError extends Error {}

/** Splits "---\nkey: value\n---\nbody" into its frontmatter and body. */
export function splitFrontmatter(source: string, file: string): { meta: Frontmatter; body: string; bodyLine: number } {
  const text = source.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new HelpContentError(`${file}: the file must start with a "---" frontmatter line`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new HelpContentError(`${file}: the frontmatter has no closing "---" line`);
  const meta: Frontmatter = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^([a-z][a-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) throw new HelpContentError(`${file}:${i + 1}: a frontmatter line is "key: value"`);
    const [, key, raw] = match;
    if (key in meta) throw new HelpContentError(`${file}:${i + 1}: "${key}" appears twice`);
    meta[key] = unquote(raw.trim());
  }
  return { meta, body: lines.slice(end + 1).join("\n"), bodyLine: end + 2 };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

/** Checks the frontmatter keys against the kind's closed list and the required ones. */
export function checkKeys(meta: Frontmatter, file: string, required: string[], optional: string[]) {
  for (const key of required) {
    if (!meta[key]) throw new HelpContentError(`${file}: "${key}" is required in the frontmatter`);
  }
  for (const key of Object.keys(meta)) {
    if (!required.includes(key) && !optional.includes(key)) throw new HelpContentError(`${file}: unknown frontmatter key "${key}"`);
  }
}

const HTML_TAG = /<\/?[A-Za-z!]/;
const OTHER_MARKDOWN = /(^|\s)(#{1,6}\s|```|\|)|!\[|\]\(|`/;

function checkInline(text: string, where: string) {
  if (HTML_TAG.test(text)) throw new HelpContentError(`${where}: raw HTML is not allowed`);
  if (OTHER_MARKDOWN.test(text)) throw new HelpContentError(`${where}: only paragraphs, ## headings, lists, steps, notes and **bold** are allowed`);
  const bold = text.match(/\*\*/g)?.length ?? 0;
  if (bold % 2 !== 0) throw new HelpContentError(`${where}: a **bold** mark is not closed`);
  if (/\*\*\s*\*\*/.test(text)) throw new HelpContentError(`${where}: an empty **bold** mark`);
}

/** Parses the body of a topic file into blocks. */
export function parseBlocks(body: string, file: string, firstLine = 1): HelpBlock[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: HelpBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }
    const start = i;
    const group: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") group.push(lines[i++].trim());
    const where = `${file}:${firstLine + start}`;
    blocks.push(groupToBlock(group, where));
  }
  return blocks;
}

function groupToBlock(group: string[], where: string): HelpBlock {
  const first = group[0];
  if (first.startsWith("## ")) {
    if (group.length > 1) throw new HelpContentError(`${where}: a heading stands alone; leave an empty line after it`);
    const h = first.slice(3).trim();
    checkInline(h, where);
    return { h };
  }
  if (/^\d+\.\s/.test(first)) {
    const steps = group.map((line, n) => {
      const match = /^(\d+)\.\s+(.+)$/.exec(line);
      if (!match) throw new HelpContentError(`${where}: every line of a steps block starts with "N. "`);
      if (Number(match[1]) !== n + 1) throw new HelpContentError(`${where}: steps are numbered 1, 2, 3 in order`);
      checkInline(match[2], where);
      return match[2];
    });
    return { steps };
  }
  if (first.startsWith("- ")) {
    const list = group.map((line) => {
      if (!line.startsWith("- ")) throw new HelpContentError(`${where}: every line of a list starts with "- "`);
      const item = line.slice(2).trim();
      checkInline(item, where);
      return item;
    });
    return { list };
  }
  if (first.startsWith("> ")) {
    const parts = group.map((line) => {
      if (!line.startsWith("> ")) throw new HelpContentError(`${where}: every line of a note starts with "> "`);
      return line.slice(2).trim();
    });
    const note = parts.join(" ");
    checkInline(note, where);
    return { note };
  }
  if (group.some((line) => /^(\d+\.|-|>)\s/.test(line) || line.startsWith("#"))) {
    throw new HelpContentError(`${where}: leave an empty line before a list, steps, a note or a heading`);
  }
  const p = group.join(" ");
  checkInline(p, where);
  return { p };
}

/** Writes blocks back as the Markdown subset (used once to move the public articles out of the code, and by the tests). */
export function blocksToMarkdown(blocks: HelpBlock[]): string {
  return blocks
    .map((block) => {
      if ("h" in block) return `## ${block.h}`;
      if ("p" in block) return block.p;
      if ("note" in block) return `> ${block.note}`;
      if ("steps" in block) return block.steps.map((s, n) => `${n + 1}. ${s}`).join("\n");
      return block.list.map((s) => `- ${s}`).join("\n");
    })
    .join("\n\n");
}

// --- The content ---

export const HELP_SCREENS = ["home", "leads", "contacts", "deals", "tasks", "reports", "settings"] as const;
export type HelpScreen = (typeof HELP_SCREENS)[number];

const CATEGORIES: HelpCategory[] = ["start", "daily", "intake", "data", "admin", "security"];

/** The "?" help of one main screen: three short lines, an optional video and the article it leads to. */
export type ScreenHelp = { screen: HelpScreen; title: string; lines: [string, string, string]; article: string; video: string | null; draft: boolean };

/** One step of the first-visit tour. */
export type TourStep = { key: string; order: number; title: string; body: string[]; screen: HelpScreen | null; draft: boolean };

export type HelpContent = { articles: HelpArticle[]; screens: ScreenHelp[]; tour: TourStep[] };

export type HelpSourceFile = { path: string; source: string };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TERM_TOKEN = /\{([a-z]+)\.([a-zA-Z]+)\}/g;
const TERM_KINDS = ["lead", "deal", "contact"];
const TERM_FORMS = ["singular", "plural", "theSingular", "thePlural", "newOne"];

function flag(meta: Record<string, string>, key: string, file: string): boolean {
  const value = meta[key];
  if (value === undefined) return false;
  if (value !== "true" && value !== "false") throw new HelpContentError(`${file}: "${key}" is true or false`);
  return value === "true";
}

function order(value: string, file: string): number {
  if (!/^\d{1,3}$/.test(value)) throw new HelpContentError(`${file}: "order" is a whole number`);
  return Number(value);
}

/** A video link is shown only when it is a plain https address (UX-07 fills them in later). */
export function videoUrlOk(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && /^[a-z0-9.-]+$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function checkTerms(text: string, file: string) {
  for (const match of text.matchAll(TERM_TOKEN)) {
    if (!TERM_KINDS.includes(match[1]) || !TERM_FORMS.includes(match[2])) {
      throw new HelpContentError(`${file}: unknown word token ${match[0]}`);
    }
  }
  if (/[{}]/.test(text.replace(TERM_TOKEN, ""))) throw new HelpContentError(`${file}: a "{" or "}" outside a word token`);
}

function parseArticle(file: HelpSourceFile, slug: string): HelpArticle & { order: number; draft: boolean } {
  const { meta, body, bodyLine } = splitFrontmatter(file.source, file.path);
  checkKeys(meta, file.path, ["title", "topic", "order", "summary"], ["draft"]);
  if (!CATEGORIES.includes(meta.topic as HelpCategory)) throw new HelpContentError(`${file.path}: unknown topic "${meta.topic}"`);
  const blocks = parseBlocks(body, file.path, bodyLine);
  if (blocks.length === 0) throw new HelpContentError(`${file.path}: the article is empty`);
  return { slug, category: meta.topic as HelpCategory, title: meta.title, summary: meta.summary, body: blocks, order: order(meta.order, file.path), draft: flag(meta, "draft", file.path) };
}

function parseScreen(file: HelpSourceFile, screen: string): ScreenHelp {
  if (!(HELP_SCREENS as readonly string[]).includes(screen)) throw new HelpContentError(`${file.path}: unknown screen "${screen}"`);
  const { meta, body, bodyLine } = splitFrontmatter(file.source, file.path);
  checkKeys(meta, file.path, ["title", "article"], ["video", "draft"]);
  const blocks = parseBlocks(body, file.path, bodyLine);
  const only = blocks[0];
  if (blocks.length !== 1 || !("list" in only) || only.list.length !== 3) {
    throw new HelpContentError(`${file.path}: the body is one list of exactly three lines`);
  }
  if (meta.video !== undefined && !videoUrlOk(meta.video)) throw new HelpContentError(`${file.path}: "video" must be an https address`);
  for (const text of [meta.title, ...only.list]) checkTerms(text, file.path);
  return {
    screen: screen as HelpScreen,
    title: meta.title,
    lines: [only.list[0], only.list[1], only.list[2]],
    article: meta.article,
    video: meta.video ?? null,
    draft: flag(meta, "draft", file.path),
  };
}

function parseTourStep(file: HelpSourceFile, key: string): TourStep {
  const { meta, body, bodyLine } = splitFrontmatter(file.source, file.path);
  checkKeys(meta, file.path, ["title", "order"], ["screen", "draft"]);
  if (meta.screen !== undefined && !(HELP_SCREENS as readonly string[]).includes(meta.screen)) {
    throw new HelpContentError(`${file.path}: unknown screen "${meta.screen}"`);
  }
  const blocks = parseBlocks(body, file.path, bodyLine);
  if (blocks.length < 1 || blocks.length > 2 || blocks.some((b) => !("p" in b))) {
    throw new HelpContentError(`${file.path}: a tour step is one or two short paragraphs`);
  }
  const paragraphs = blocks.map((b) => ("p" in b ? b.p : ""));
  for (const text of [meta.title, ...paragraphs]) checkTerms(text, file.path);
  return { key, order: order(meta.order, file.path), title: meta.title, body: paragraphs, screen: (meta.screen as HelpScreen | undefined) ?? null, draft: flag(meta, "draft", file.path) };
}

/** The tour has exactly this many steps (UX-05 (א)). */
export const TOUR_LENGTH = 5;

/** Reads every file of docs/help/ (paths relative to it, "/" separated) into the content, checking it whole. */
export function buildHelpContent(files: HelpSourceFile[]): HelpContent {
  const articles: (HelpArticle & { order: number; draft: boolean })[] = [];
  const screens: ScreenHelp[] = [];
  const tour: TourStep[] = [];
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const match = /^(articles|screens|tour)\/([^/]+)\.md$/.exec(file.path);
    if (!match) throw new HelpContentError(`${file.path}: help files live in articles/, screens/ or tour/ and end in .md`);
    const [, kind, name] = match;
    if (kind === "tour") {
      const step = /^\d+-([a-z0-9-]+)$/.exec(name);
      if (!step) throw new HelpContentError(`${file.path}: a tour file is named <n>-<key>.md`);
      tour.push(parseTourStep(file, step[1]));
      continue;
    }
    if (!SLUG.test(name)) throw new HelpContentError(`${file.path}: a file name is lower-case words joined by "-"`);
    if (kind === "articles") articles.push(parseArticle(file, name));
    else screens.push(parseScreen(file, name));
  }

  const slugs = new Set(articles.map((a) => a.slug));
  for (const screen of HELP_SCREENS) {
    const help = screens.find((s) => s.screen === screen);
    if (!help) throw new HelpContentError(`screens/${screen}.md is missing`);
    if (!slugs.has(help.article)) throw new HelpContentError(`screens/${screen}.md: article "${help.article}" does not exist`);
  }
  if (tour.length !== TOUR_LENGTH) throw new HelpContentError(`the tour has ${tour.length} steps; it must have ${TOUR_LENGTH}`);
  const orders = tour.map((s) => s.order);
  if (new Set(orders).size !== orders.length) throw new HelpContentError("two tour steps share an order");

  articles.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.order - b.order || (a.slug < b.slug ? -1 : 1));
  screens.sort((a, b) => HELP_SCREENS.indexOf(a.screen) - HELP_SCREENS.indexOf(b.screen));
  tour.sort((a, b) => a.order - b.order);
  return {
    articles: articles.map(({ slug, category, title, summary, body, draft }) => (draft ? { slug, category, title, summary, body, draft } : { slug, category, title, summary, body })),
    screens,
    tour,
  };
}

/** The text of content.generated.ts: the content as data, so the app never parses Markdown at run time. */
export function renderGeneratedModule(content: HelpContent): string {
  return [
    "// GENERATED by scripts/build-help-content.mjs from docs/help/. Do not edit: change the Markdown and run the script.",
    "",
    'import type { HelpContent } from "./content";',
    "",
    `export const HELP_CONTENT: HelpContent = ${JSON.stringify(content, null, 2)};`,
    "",
  ].join("\n");
}
