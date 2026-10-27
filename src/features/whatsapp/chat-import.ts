/**
 * WAB-07: reading a WhatsApp "export chat" text file, and the timeline entry made from it.
 *
 * Pure functions (no database, no clock of their own), used by the server action and the unit tests.
 * The formats WhatsApp writes, by phone and language:
 *
 *   Android:  31/12/2024, 22:15 - דני: שלום          (also 31.12.2024 and 12/31/24, 10:15 PM)
 *   iPhone:   [31/12/2024, 22:15:30] דני: שלום       (often with U+200E before the "[")
 *
 * A message may run over several lines; a line that does not start a message belongs to the one
 * before it. Lines with no "name: " are WhatsApp's own notices (encryption, "X added Y") and are
 * left out; on an iPhone those notices carry U+200E right after "name: ". Attachments are not in
 * the text file at all, only a placeholder ("<Media omitted>", "image omitted", ...), which is kept
 * as one short line. Phone numbers inside the text stay text: nothing here creates or links records.
 *
 * The times in the file are the exporting phone's wall clock, with no zone: they are read in the
 * business's time zone.
 */

import { zonedIso } from "@/lib/format";

// --- Limits -----------------------------------------------------------------------------------

/**
 * The largest text accepted, in UTF-8 bytes. A Server Action request is capped at 1 MB by default
 * (next.config `serverActions.bodySizeLimit`, shared ground), so the file stays under it.
 */
export const CHAT_MAX_BYTES = 900 * 1024;
/** The most messages read from one file (more than this is refused as too long). */
export const CHAT_MAX_MESSAGES = 20_000;
/** The stored entry's text is at most this long (the activities_body_length constraint is 10,000). */
export const CHAT_BODY_MAX = 10_000;
/** One message is cut after this many characters in the entry. */
export const CHAT_MESSAGE_MAX = 1_500;
/** Participants kept in the entry's metadata. */
export const CHAT_PARTICIPANTS_MAX = 20;
const NAME_MAX = 60;
const AUTHOR_MAX = 100;

// --- Parsing ----------------------------------------------------------------------------------

export type ChatMessage = {
  // the phone's wall clock: "YYYY-MM-DD" and "HH:MM:SS"
  date: string;
  time: string;
  author: string;
  text: string;
  media: boolean;
};

export type ParsedChat = {
  messages: ChatMessage[];
  // WhatsApp's own notices that were left out
  systemLines: number;
};

export type ChatParseError = "empty" | "not_whatsapp" | "too_many";

// bidi marks and isolates, and the byte order mark: never part of a name or a message
const MARK_CHARS = new Set([0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]);
const MARKS_ALL = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
// A message's first line starts with its date and time, well within this many characters (marks not counted). The
// header patterns run on that prefix only, with the marks taken out first, so no line, however long or odd, makes them slow.
const HEADER_SCAN = 80;
const DATE = "(\\d{1,4})([./-])(\\d{1,2})\\2(\\d{1,4})";
const TIME = "(\\d{1,2})[:.](\\d{2})(?:[:.](\\d{2}))?";
// English, and the Hebrew forms a phone in Hebrew writes (לפנה״צ / אחה״צ, with either quote mark)
const AMPM = "(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?|לפנה[\"״׳']?צ|אחה[\"״׳']?צ)";
const ANDROID = new RegExp(`^${DATE},? {1,3}${TIME}(?: {0,3}${AMPM})? {0,3}[-–] ?`, "i");
const IPHONE = new RegExp(`^\\[${DATE},? {1,3}${TIME}(?: {0,3}${AMPM})?\\] ?`, "i");

const MEDIA_PATTERNS = [
  /^<media omitted>$/i,
  /^<[^<>]*הושמט[^<>]*>$/,
  /^<attached: [^<>]+>$/i,
  /^<מצורף: [^<>]+>$/,
  /\((file attached|קובץ מצורף)\)$/i,
  /\bomitted$/i,
  /^[^\n]{0,40}הושמט(ה)?$/,
];

type Header = {
  a: number;
  sep: string;
  b: number;
  c: number;
  aDigits: number;
  hour: number;
  minute: number;
  second: number;
  ampm: "am" | "pm" | null;
  rest: string;
  iphone: boolean;
};

function readHeader(line: string): Header | null {
  // the line's first characters without the marks, and where each of them sits in the line
  let head = "";
  const at: number[] = [];
  let i = 0;
  for (; i < line.length && head.length < HEADER_SCAN; i += 1) {
    if (MARK_CHARS.has(line.charCodeAt(i))) continue;
    head += line[i];
    at.push(i);
  }
  at.push(i);
  const iphoneMatch = IPHONE.exec(head);
  const match = iphoneMatch ?? ANDROID.exec(head);
  if (!match) return null;
  const [whole, a, sep, b, c, hour, minute, second, ampm] = match;
  const marker = ampm?.toLowerCase().replace(/[\s.]/g, "") ?? null;
  return {
    a: Number(a),
    sep,
    b: Number(b),
    c: Number(c),
    aDigits: a.length,
    hour: Number(hour),
    minute: Number(minute),
    second: second ? Number(second) : 0,
    ampm: marker === null ? null : marker === "am" || marker.startsWith("לפנה") ? "am" : "pm",
    // the rest of the line as written, marks kept (an iPhone notice is told by the U+200E after "name: ")
    rest: line.slice(at[whole.length]),
    iphone: iphoneMatch !== null,
  };
}

type DateOrder = "dmy" | "mdy" | "ymd";

/** Day-first or month-first, decided once for the whole file (as WhatsApp writes one format per export). */
function dateOrder(headers: Header[]): DateOrder {
  if (headers.some((h) => h.aDigits === 4)) return "ymd";
  if (headers.some((h) => h.a > 12)) return "dmy";
  if (headers.some((h) => h.b > 12)) return "mdy";
  // nothing tells them apart: an American phone writes "12/31/24, 10:15 PM"; Israel and most of the world day first
  return headers.some((h) => h.sep === "/" && h.ampm !== null) ? "mdy" : "dmy";
}

const pad = (n: number) => String(n).padStart(2, "0");

function headerMoment(h: Header, order: DateOrder): { date: string; time: string } | null {
  const [y, m, d] = order === "ymd" ? [h.a, h.b, h.c] : order === "dmy" ? [h.c, h.b, h.a] : [h.c, h.a, h.b];
  const year = y < 100 ? 2000 + y : y;
  if (year < 2009 || year > 2100 || m < 1 || m > 12 || d < 1) return null;
  const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
  if (d > days) return null;
  let hour = h.hour;
  if (h.ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = h.ampm === "am" ? hour % 12 : (hour % 12) + 12;
  }
  if (hour > 23 || h.minute > 59 || h.second > 59) return null;
  return { date: `${year}-${pad(m)}-${pad(d)}`, time: `${pad(hour)}:${pad(h.minute)}:${pad(h.second)}` };
}

function cleanName(raw: string): string {
  return raw.replace(MARKS_ALL, "").replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

function isMedia(text: string): boolean {
  const value = text.trim();
  return value !== "" && value.length <= 300 && !value.includes("\n") && MEDIA_PATTERNS.some((pattern) => pattern.test(value));
}

/** The text of an exported chat as messages, or why it cannot be read. */
export function parseWhatsappChat(input: string): { ok: true; chat: ParsedChat } | { ok: false; reason: ChatParseError } {
  // every byte order mark goes (not only a leading one), and the no-break spaces become plain spaces
  const text = input.replace(/\ufeff/g, "").replace(/\r\n?/g, "\n").replace(/[\u202f\u00a0\t]/g, " ");
  if (text.trim() === "") return { ok: false, reason: "empty" };
  const lines = text.split("\n");

  // first pass: the lines that look like the start of a message, to decide the date order
  const headers = lines.map(readHeader);
  const found = headers.filter((h): h is Header => h !== null);
  if (found.length === 0) return { ok: false, reason: "not_whatsapp" };
  const order = dateOrder(found);

  type Draft = { date: string; time: string; author: string | null; raw: string; iphone: boolean; lines: string[] };
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const header = headers[i];
    const moment = header ? headerMoment(header, order) : null;
    if (header && moment) {
      if (drafts.length >= CHAT_MAX_MESSAGES * 2) return { ok: false, reason: "too_many" };
      const rest = header.rest;
      const colon = rest.indexOf(": ");
      const authorRaw = colon > 0 ? rest.slice(0, colon) : null;
      const author = authorRaw !== null && authorRaw.length <= AUTHOR_MAX ? cleanName(authorRaw) : null;
      current = {
        date: moment.date,
        time: moment.time,
        author: author === "" ? null : author,
        raw: author ? rest.slice(colon + 2) : rest,
        iphone: header.iphone,
        lines: [],
      };
      drafts.push(current);
    } else if (current) {
      current.lines.push(lines[i]);
    }
    // lines before the first message (a title some tools add) are left out
  }

  const messages: ChatMessage[] = [];
  let systemLines = 0;
  for (const draft of drafts) {
    const body = [draft.raw, ...draft.lines].join("\n").trimEnd();
    const clean = body.replace(MARKS_ALL, "");
    const media = isMedia(clean);
    // no "name: " = WhatsApp's own notice; on an iPhone the notice follows "name: " with U+200E
    const system = draft.author === null || (draft.iphone && !media && /^\u200e/.test(draft.raw));
    if (system) {
      systemLines += 1;
      continue;
    }
    messages.push({ date: draft.date, time: draft.time, author: draft.author!, text: clean.trim(), media });
  }
  if (messages.length === 0) return { ok: false, reason: "not_whatsapp" };
  if (messages.length > CHAT_MAX_MESSAGES) return { ok: false, reason: "too_many" };
  return { ok: true, chat: { messages, systemLines } };
}

/** What the person is told when a file cannot be imported (the ZIP reasons are read in the browser). */
export const CHAT_ERRORS: Record<ChatParseError | "too_big" | "no_file" | "no_chat" | "unsupported", string> = {
  no_file: "בחרו את קובץ השיחה.",
  empty: "הקובץ ריק.",
  not_whatsapp: "זה לא נראה כמו שיחה שיוצאה מ-WhatsApp. בחרו את קובץ הטקסט של הייצוא.",
  too_many: "השיחה ארוכה מדי לייבוא (עד 20,000 הודעות).",
  no_chat: "לא מצאנו בקובץ ה-ZIP את קובץ הטקסט של השיחה.",
  unsupported: "אי אפשר לקרוא את קובץ ה-ZIP הזה. נסו לייצא את השיחה בלי מדיה ולהעלות את קובץ הטקסט.",
  too_big: "הקובץ גדול מדי (עד 900KB של טקסט).",
};

// --- The timeline entry -----------------------------------------------------------------------

export const WHATSAPP_IMPORT_KIND = "whatsapp_import";

// the closed list public.whatsapp_chat_import accepts and rebuilds (keep the two in step)
export type ChatImportMetadata = {
  via: "import";
  kind: typeof WHATSAPP_IMPORT_KIND;
  first_message_at: string;
  last_message_at: string;
  message_count: number;
  kept_count: number;
  truncated: boolean;
  media_count: number;
  participants: string[];
  participant_count: number;
};

export type ChatEntry = { body: string; occurredAt: string; metadata: ChatImportMetadata };

const MEDIA_TEXT = "(קובץ מצורף, לא יובא)";

function displayDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

function messageLine(message: ChatMessage): string {
  const text = message.media ? MEDIA_TEXT : message.text.length > CHAT_MESSAGE_MAX ? `${message.text.slice(0, CHAT_MESSAGE_MAX)}…` : message.text;
  return `${displayDate(message.date)} ${message.time.slice(0, 5)} · ${message.author}: ${text}`;
}

const count = (n: number) => n.toLocaleString("he-IL");

/**
 * The one timeline entry a chat becomes: a short header (how many messages, from when to when, who
 * wrote), then the messages oldest first. When they do not all fit in one entry the latest ones are
 * kept, and the header says so. The entry's time is the last message's, never later than now.
 */
export function chatEntry(chat: ParsedChat, timeZone: string, now: Date): ChatEntry {
  const { messages } = chat;
  const instants = messages.map((message) => zonedIso(message.date, message.time, timeZone));
  const nowIso = now.toISOString();
  const clamp = (iso: string) => (iso > nowIso ? nowIso : iso);
  const sorted = [...instants].sort();
  const firstAt = clamp(sorted[0]);
  const lastAt = clamp(sorted[sorted.length - 1]);

  // first appearance order; a Set keeps it linear (RVW-60: includes() in a loop was quadratic in the authors)
  const participants = [...new Set(messages.map((message) => message.author))];
  const mediaCount = messages.filter((message) => message.media).length;

  const shownNames = participants.slice(0, CHAT_PARTICIPANTS_MAX);
  const more = participants.length - shownNames.length;
  const first = displayDate(messages[0].date);
  const last = displayDate(messages[messages.length - 1].date);
  const header = [
    `שיחת WhatsApp מיובאת: ${messages.length === 1 ? "הודעה אחת" : `${count(messages.length)} הודעות`}, ${first === last ? first : `${first} עד ${last}`}.`,
    `משתתפים: ${shownNames.join(", ")}${more > 0 ? ` ועוד ${count(more)}` : ""}.`,
    ...(mediaCount > 0 ? [`קבצים מצורפים לא יובאו (${count(mediaCount)}).`] : []),
  ];

  const lines = messages.map(messageLine);
  // room for the header, the truncation line and the blank line between them and the messages
  const truncationLine = (kept: number) =>
    `השיחה ארוכה מדי לרשומה אחת: נשמרו ${count(kept)} ההודעות האחרונות מתוך ${count(messages.length)}.`;
  const reserve = header.join("\n").length + truncationLine(messages.length).length + 4;
  let budget = CHAT_BODY_MAX - reserve;
  let start = lines.length;
  while (start > 0 && budget - lines[start - 1].length - 1 >= 0) {
    budget -= lines[start - 1].length + 1;
    start -= 1;
  }
  const kept = lines.length - start;
  const truncated = start > 0;
  const body = [...header, ...(truncated ? [truncationLine(kept)] : []), "", ...lines.slice(start)].join("\n");

  return {
    body,
    occurredAt: lastAt,
    metadata: {
      via: "import",
      kind: WHATSAPP_IMPORT_KIND,
      first_message_at: firstAt,
      last_message_at: lastAt,
      message_count: messages.length,
      kept_count: kept,
      truncated,
      media_count: mediaCount,
      participants: shownNames,
      participant_count: participants.length,
    },
  };
}

/**
 * Whether a timeline entry is an imported WhatsApp chat. Owner, 26 October 2026 (answer (ב)): history, never contact or
 * activity, so it is stored as an 'import_note' (GAP-12) whose metadata.kind says what it is.
 */
export function isWhatsappImport(type: string, kind: string | null): boolean {
  return type === "import_note" && kind === WHATSAPP_IMPORT_KIND;
}
