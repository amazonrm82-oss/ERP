/**
 * REC-02: how a mention is written into a note. The text stays plain (REC-04 Markdown):
 *
 *   @[Name](user:<uuid>)
 *
 * Name: 1 to 100 characters (code points, as Postgres counts them; hence the "u" flag below),
 * without "]" or a line break; it is the name shown when the
 * mention was written, and the timeline shows the user's current name instead when it knows it.
 * The database reads the ids with the same grammar (app.mention_ids(), migration 0099);
 * keep the two in step.
 */

export const MENTION_NAME_MAX = 100;
// at most this many people in one entry (hint mention:too_many in the database)
export const MENTION_MAX = 20;

const UUID = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";
const MENTION_SOURCE = `@\\[([^\\]\\n]{1,${MENTION_NAME_MAX}})\\]\\(user:(${UUID})\\)`;
// sticky: matches only at the position it is asked about
const MENTION_AT = new RegExp(MENTION_SOURCE, "uy");
const MENTION_HREF = new RegExp(`^user:(${UUID})$`, "u");

const codePoints = (text: string) => Array.from(text).length;

export type Mention = { userId: string; name: string; length: number };

/** The mention that starts at `index` of `text` (on its "@"), or null. */
export function mentionAt(text: string, index: number): Mention | null {
  MENTION_AT.lastIndex = index;
  const match = MENTION_AT.exec(text);
  if (!match) return null;
  return { name: match[1], userId: match[2].toLowerCase(), length: match[0].length };
}

/** Whether "[name](href)" right after an "@" is a mention (the name already found between the brackets). */
export function isMentionLink(name: string, href: string): boolean {
  return name.length >= 1 && codePoints(name) <= MENTION_NAME_MAX && !name.includes("\n") && !name.includes("]") && MENTION_HREF.test(href);
}

/** Every user id mentioned in a text, once each, in lower case. */
export function mentionIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(new RegExp(MENTION_SOURCE, "gu"))) {
    ids.add(match[2].toLowerCase());
  }
  return [...ids];
}

/** A name made safe to sit between the brackets: no "]", "[" or line breaks, trimmed and cut to length. */
export function mentionName(name: string): string {
  const clean = Array.from(name.replace(/[[\]\r\n]/g, " ").replace(/\s+/g, " ").trim())
    .slice(0, MENTION_NAME_MAX)
    .join("")
    .trim();
  return clean === "" ? "משתמש" : clean;
}

/** The token for one user. */
export function mentionToken(userId: string, name: string): string {
  return `@[${mentionName(name)}](user:${userId})`;
}

// one person the picker lists (public.mention_candidates)
export type MentionCandidate = { id: string; name: string };
