/**
 * REC-04: basic rich text in notes. A small subset of Markdown, stored as text:
 *
 *   **bold**            bold text
 *   - item / * item     a bulleted list (one item per line)
 *   1. item             a numbered list
 *   [text](https://…)   a link; only http(s), mailto: and tel: addresses
 *   \*                  a backslash keeps the next mark character as it is
 *
 * Nothing here produces HTML. `parseNote()` builds a small tree that React renders as
 * elements, so any tag a person types is shown as text. A link whose address is not
 * allowed stays plain text, both when saving (`sanitizeNote`) and when showing.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "paragraph"; lines: Inline[][] }
  | { kind: "bullets"; items: Inline[][] }
  | { kind: "numbers"; items: Inline[][]; start: number };

const MAX_URL = 2000;
const ESCAPABLE = new Set(["\\", "*", "[", "]", "(", ")", "-", "#", "_", "`"]);
const BULLET = /^\s{0,3}[-*\u2022]\s+(.*)$/;
const NUMBER = /^\s{0,3}(\d{1,6})[.)]\s+(.*)$/;
// C0 and C1 control characters except tab and line feed, and the Unicode bidi overrides
// (RLO/LRO and friends) that can disguise a link's text
const UNSAFE_CLASS = "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]";
const UNSAFE_CHAR = new RegExp(UNSAFE_CLASS);
const UNSAFE_CHARS = new RegExp(UNSAFE_CLASS, "g");
// a link's words are short; the scan for the closing bracket stops here
const MAX_LINK_TEXT = 500;

/**
 * The address a link may point to, normalized, or null. Only http(s), mailto: and tel:;
 * no spaces, no control characters, no credentials in a web address.
 */
export function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.length > MAX_URL || /[\s<>"'`\\]/.test(value) || UNSAFE_CHAR.test(value)) {
    return null;
  }
  const withScheme = /^www\./i.test(value) ? `https://${value}` : value;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(withScheme)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      return null;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) {
      return null;
    }
    return url.href;
  }
  if (scheme === "mailto") {
    return /^mailto:[^@/?#]+@[^@/?#]+\.[^@/?#]+(\?[^#]*)?$/i.test(withScheme) ? withScheme : null;
  }
  if (scheme === "tel") {
    return /^tel:\+?[0-9()\-.]{3,30}$/i.test(withScheme) ? withScheme : null;
  }
  return null;
}

function pushText(out: Inline[], text: string): void {
  if (text === "") return;
  const last = out[out.length - 1];
  if (last && last.kind === "text") {
    last.text += text;
  } else {
    out.push({ kind: "text", text });
  }
}

/** Index of the closing `**` from `from`, skipping escaped characters; -1 when there is none. */
function findBoldEnd(line: string, from: number): number {
  for (let i = from; i < line.length - 1; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "*" && line[i + 1] === "*") return i;
  }
  return -1;
}

/** `[text](address)` starting at `start`: the text, the address and where it ends; null when it is not one. */
function readLink(line: string, start: number): { text: string; href: string; end: number } | null {
  let depth = 0;
  let i = start + 1;
  const limit = Math.min(line.length, start + 1 + MAX_LINK_TEXT);
  for (; i < limit; i++) {
    const ch = line[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") {
      if (depth === 0) break;
      depth--;
    }
  }
  if (i >= limit || line[i + 1] !== "(") return null;
  // the address is at most MAX_URL long, so the search for ")" stops there (RVW-3)
  const close = line.slice(i + 2, i + 3 + MAX_URL).indexOf(")");
  if (close < 0) return null;
  return { text: line.slice(start + 1, i), href: line.slice(i + 2, i + 2 + close), end: i + 3 + close };
}

function parseInline(line: string, allowLinks: boolean, allowBold: boolean): Inline[] {
  const out: Inline[] = [];
  // once no closing ** is left after some point, none is left after any later point either
  let boldPossible = allowBold;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length && ESCAPABLE.has(line[i + 1])) {
      pushText(out, line[i + 1]);
      i += 2;
      continue;
    }
    if (boldPossible && ch === "*" && line[i + 1] === "*") {
      const end = findBoldEnd(line, i + 2);
      if (end < 0) {
        boldPossible = false;
      } else if (end > i + 2) {
        out.push({ kind: "bold", children: parseInline(line.slice(i + 2, end), allowLinks, false) });
        i = end + 2;
        continue;
      }
    }
    if (allowLinks && ch === "[") {
      const link = readLink(line, i);
      if (link && link.text.trim() !== "") {
        const href = safeHref(link.href);
        const children = parseInline(link.text, false, allowBold);
        if (href) {
          out.push({ kind: "link", href, children });
        } else {
          // an address that is not allowed: show the words, drop the address
          for (const child of children) {
            if (child.kind === "text") pushText(out, child.text);
            else out.push(child);
          }
        }
        i = link.end;
        continue;
      }
    }
    pushText(out, ch);
    i++;
  }
  return out;
}

/** Removes characters that have no place in a note (control characters, bidi overrides) and unifies line ends. */
export function cleanNoteText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(UNSAFE_CHARS, "");
}

/** The note as blocks of paragraphs and lists, for rendering. */
export function parseNote(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = cleanNoteText(text).split("\n");
  let paragraph: Inline[][] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };

  for (const line of lines) {
    const bullet = BULLET.exec(line);
    const number = bullet ? null : NUMBER.exec(line);
    if (bullet) {
      flushParagraph();
      const last = blocks[blocks.length - 1];
      const item = parseInline(bullet[1], true, true);
      if (last && last.kind === "bullets") last.items.push(item);
      else blocks.push({ kind: "bullets", items: [item] });
    } else if (number) {
      flushParagraph();
      const last = blocks[blocks.length - 1];
      const item = parseInline(number[2], true, true);
      if (last && last.kind === "numbers") last.items.push(item);
      else blocks.push({ kind: "numbers", items: [item], start: Math.min(Number(number[1]), 999999) });
    } else if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraph.push(parseInline(line, true, true));
    }
  }
  flushParagraph();
  return blocks;
}

/**
 * What is stored (REC-04): the text as typed, minus control characters, with any link whose
 * address is not allowed reduced to its words. Everything else, marks included, stays as typed.
 */
export function sanitizeNote(text: string): string {
  return cleanNoteText(text).split("\n").map(sanitizeLine).join("\n");
}

/**
 * One line of `sanitizeNote`. Same result as
 * `line.replace(/\[([^\]\n]*)\]\(([^)\n]*)\)/g, …)`, but a single pass (RVW-3): that regex
 * tried every "[" and ran to the next "]" from each one, so a line of "[[[[…" took quadratic time.
 * A "[" can only pair with the first "]" after it, and that "]" with the first ")" after it, so
 * when a "[" fails, every "[" before the same "]" fails too, and the scan jumps past it.
 */
function sanitizeLine(line: string): string {
  let out = "";
  let copied = 0;
  let from = 0;
  while (from < line.length) {
    const open = line.indexOf("[", from);
    if (open < 0) break;
    const close = line.indexOf("]", open + 1);
    // no "]" after this "[": none after any later one either
    if (close < 0) break;
    if (line[close + 1] !== "(") {
      from = close + 1;
      continue;
    }
    const end = line.indexOf(")", close + 2);
    // no ")" after this "](": none after any later one either
    if (end < 0) break;
    // an escaped bracket is text, not a link
    const escaped = open > 0 && line[open - 1] === "\\";
    if (!escaped && !safeHref(line.slice(close + 2, end))) {
      out += line.slice(copied, open) + line.slice(open + 1, close);
      copied = end + 1;
    }
    from = end + 1;
  }
  return copied === 0 ? line : out + line.slice(copied);
}

/** The note as plain words, for a one-line preview (search results, notifications). */
export function notePlainText(text: string): string {
  return parseNote(text)
    .map((block) => {
      if (block.kind === "paragraph") return block.lines.map(plainInline).join(" ");
      return block.items.map(plainInline).join(", ");
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function plainInline(nodes: Inline[]): string {
  return nodes.map((node) => (node.kind === "text" ? node.text : plainInline(node.children))).join("");
}
