// WAB-06: "שתף ל-Mexuz". The installed app is a share target (Chrome on Android): text, a link or one image shared from
// another app arrives here. The service worker (public/sw.js) catches the share, keeps it on this device only (Cache
// Storage) and opens the share screen, which offers a new lead prefilled or a note on a record the person picks. Nothing
// is stored on the server before the person saves; the image goes up through the normal file upload of the record.
// This file is pure: the manifest entry, the addresses the worker and the pages share, and how a share becomes a prefill.

import { plainMentions } from "@/features/whatsapp/templates";
import { ALLOWED_TYPES, FILE_MAX_BYTES } from "@/features/files/types";
import { normalizePhone } from "@/lib/phone";

/** Where the share arrives (POST multipart). public/sw.js answers it; the server route is the fallback. */
export const SHARE_RECEIVE_PATH = "/app/share/receive";
/** The screen that picks the business, then /o/<org>/share. */
export const SHARE_PAGE_PATH = "/app/share";
/** What the worker answers from its cache: <prefix><id> (the text, as JSON) and <prefix><id>/image (the image). */
export const SHARE_ITEM_PREFIX = "/app/share/item/";
/** The form field of the image in the share. */
export const SHARE_IMAGE_FIELD = "image";
/** The images a record file may be (ALLOWED_TYPES), so the phone offers the app only for what can be attached. */
export const SHARE_IMAGE_TYPES = Object.keys(ALLOWED_TYPES).filter((type) => type.startsWith("image/"));
/** A share older than this is dropped by the worker (mirrored in public/sw.js as SHARE_MAX_AGE_MS). */
export const SHARE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SHARE_IMAGE_MAX_BYTES = FILE_MAX_BYTES;

export const SHARE_TITLE_MAX = 300;
export const SHARE_TEXT_MAX = 5000;
export const SHARE_URL_MAX = 2000;
/** A note holds up to 5,000 characters (activities schema). */
export const NOTE_MAX = 5000;

/** The manifest's share_target: one entry only (the standard allows one), so text and the image share one POST. */
export function shareTarget() {
  return {
    action: SHARE_RECEIVE_PATH,
    method: "POST" as const,
    enctype: "multipart/form-data" as const,
    params: {
      title: "title",
      text: "text",
      url: "url",
      files: [{ name: SHARE_IMAGE_FIELD, accept: SHARE_IMAGE_TYPES }],
    },
  };
}

export type SharedInput = { title?: string | null; text?: string | null; url?: string | null };
export type SharedClean = { title: string; text: string; url: string | null };

const cap = (value: string | null | undefined, max: number) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, max).trim() : "");

const URL_ONLY = /^https?:\/\/\S+$/i;

/** A web address worth keeping: http(s) only and parsable (javascript:, data:, intent: and the like are dropped). */
export function webUrl(value: string | null | undefined): string | null {
  const text = cap(value, SHARE_URL_MAX);
  if (!URL_ONLY.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The share as it arrived, trimmed and capped. Many apps send a link in `text` and nothing in `url`: a text that is only
 * one web address becomes the url.
 */
export function cleanShared(input: SharedInput): SharedClean {
  const title = cap(input.title, SHARE_TITLE_MAX);
  let text = cap(input.text, SHARE_TEXT_MAX);
  // anything but http(s) (javascript:, data:, intent:, tel:, mailto:) is never kept as a link
  let url = webUrl(input.url);
  if (!url) {
    const fromText = webUrl(text);
    if (fromText) {
      url = fromText;
      text = "";
    }
  }
  return { title, text, url };
}

// one address and nothing else; no spaces, no second @, a dot in the domain
const EMAIL_ONLY = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
// digits with the usual separators, an optional leading +; nothing else
const PHONE_ONLY = /^\+?[\d\s\-().]+$/;

/** An email only when the whole value is one address (or a mailto: link to one). Answers it in lower case. */
export function clearEmail(value: string | null | undefined): string | null {
  let text = (value ?? "").trim();
  if (/^mailto:/i.test(text)) {
    text = text.slice("mailto:".length).split("?")[0];
    try {
      text = decodeURIComponent(text);
    } catch {
      return null;
    }
  }
  if (text.length > 254 || !EMAIL_ONLY.test(text)) return null;
  return text.toLowerCase();
}

/**
 * A phone only when the whole value is one number (or a tel: link): digits with spaces, dashes, dots or brackets, an
 * Israeli number of 9-10 digits from 0, or an international one with + / 00 / 972 of 8-15 digits. A sentence with a
 * number inside it is not a phone: the text goes to the note and nothing is guessed. Answers the number as typed.
 */
export function clearPhone(value: string | null | undefined): string | null {
  let text = (value ?? "").trim();
  if (/^tel:/i.test(text)) {
    try {
      text = decodeURIComponent(text.slice("tel:".length)).trim();
    } catch {
      return null;
    }
  }
  if (text.length === 0 || text.length > 24 || !PHONE_ONLY.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  const international = text.startsWith("+") || digits.startsWith("00") || digits.startsWith("972");
  if (!international && !(digits.startsWith("0") && (digits.length === 9 || digits.length === 10))) return null;
  const e164 = normalizePhone(text);
  if (!e164 || !/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  return text;
}

export type SharePrefill = {
  /** the note: title, text and link, each once */
  note: string;
  phone: string | null;
  email: string | null;
  url: string | null;
};

/**
 * What the screens start with. A phone or an email is offered only when a whole field is clearly one (title, text, or a
 * tel:/mailto: link); the rest goes to the note as it was shared. Mention tokens are flattened, so a shared text never
 * tells a colleague anything.
 */
export function sharePrefill(input: SharedInput): SharePrefill {
  const rawUrl = cap(input.url, SHARE_URL_MAX);
  const shared = cleanShared(input);
  const candidates = [rawUrl, shared.text, shared.title];
  const phone = candidates.map(clearPhone).find((value) => value !== null) ?? null;
  const email = candidates.map(clearEmail).find((value) => value !== null) ?? null;
  const taken = (value: string) => value === "" || clearPhone(value) !== null || clearEmail(value) !== null;
  const lines: string[] = [];
  const add = (value: string) => {
    if (!taken(value) && !lines.includes(value)) lines.push(value);
  };
  // a page's title is worth keeping beside its link; a title that repeats the text is not
  if (shared.title && !shared.text.startsWith(shared.title)) add(shared.title);
  add(shared.text);
  if (shared.url && !shared.text.includes(shared.url)) add(shared.url);
  const note = plainMentions(lines.join("\n")).slice(0, NOTE_MAX).trim();
  return { note, phone, email, url: shared.url };
}

/** The new-lead form's starting values (LeadForm `prefill`). */
export function leadPrefill(prefill: SharePrefill): Record<string, string> {
  const values: Record<string, string> = {};
  if (prefill.phone) values.phone = prefill.phone;
  if (prefill.email) values.email = prefill.email;
  if (prefill.note) values.message = prefill.note;
  return values;
}

/** The note's starting text; a shared image alone still needs a line (the person may change it). */
export const IMAGE_ONLY_NOTE = "תמונה ששותפה";
export function noteStart(prefill: SharePrefill, hasImage: boolean): string {
  return prefill.note || (hasImage ? IMAGE_ONLY_NOTE : "");
}

const SHARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isShareId(value: unknown): value is string {
  return typeof value === "string" && SHARE_ID.test(value);
}

// imageDropped: the server fallback got the share and never keeps an image; failed: the worker could not keep the share
export type ShareParams = { s: string | null; title: string; text: string; url: string; imageDropped: boolean; failed: boolean };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/**
 * The share screen's address carries either the id of the share the worker keeps (`s`), or, when no worker caught the
 * share (the server fallback), the text itself and `image=dropped` (the server never keeps the image).
 */
export function readShareParams(params: Record<string, string | string[] | undefined>): ShareParams {
  const s = first(params.s);
  return {
    s: isShareId(s) ? s.toLowerCase() : null,
    title: cap(first(params.title), SHARE_TITLE_MAX),
    text: cap(first(params.text), SHARE_TEXT_MAX),
    url: cap(first(params.url), SHARE_URL_MAX),
    imageDropped: first(params.image) === "dropped",
    failed: first(params.failed) === "1",
  };
}

export function shareQuery(params: ShareParams): string {
  const query = new URLSearchParams();
  if (params.s) query.set("s", params.s);
  if (params.title) query.set("title", params.title);
  if (params.text) query.set("text", params.text);
  if (params.url) query.set("url", params.url);
  if (params.imageDropped) query.set("image", "dropped");
  if (params.failed) query.set("failed", "1");
  const out = query.toString();
  return out ? `?${out}` : "";
}

export function sharePath(orgId: string, params: ShareParams): string {
  return `/o/${orgId}/share${shareQuery(params)}`;
}

/** The worker's answer for a share id: the text, and what is known of the image. */
export type StoredShare = SharedClean & { image: { name: string; type: string; size: number } | null; imageRefused: boolean; at: number };

export function readStoredShare(value: unknown, now: number): StoredShare | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const at = typeof row.at === "number" ? row.at : NaN;
  if (!Number.isFinite(at) || now - at > SHARE_MAX_AGE_MS) return null;
  const image = row.image && typeof row.image === "object" ? (row.image as Record<string, unknown>) : null;
  const imageOk =
    image &&
    typeof image.type === "string" &&
    SHARE_IMAGE_TYPES.includes(image.type) &&
    typeof image.size === "number" &&
    image.size > 0 &&
    image.size <= SHARE_IMAGE_MAX_BYTES;
  return {
    title: cap(typeof row.title === "string" ? row.title : "", SHARE_TITLE_MAX),
    text: cap(typeof row.text === "string" ? row.text : "", SHARE_TEXT_MAX),
    url: typeof row.url === "string" ? row.url : null,
    imageRefused: row.imageRefused === true,
    image: imageOk ? { name: cap(typeof image.name === "string" ? image.name : "", 200) || "תמונה", type: image.type as string, size: image.size as number } : null,
    at,
  };
}
