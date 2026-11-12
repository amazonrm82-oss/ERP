import { isPublicEmailDomain, registeredDomain, websiteDomain } from "@/features/company-domain/domains";
import { SERVICE_MESSAGE_TYPES, type MessageChannel, type MessageType } from "@/features/messaging/providers/types";

import { INSTANT_REPLY_LINK, INSTANT_REPLY_OFFER } from "@/lib/errors";

import { marketingEnvelope, type EnvelopeInput } from "./envelope";
import { MERGE_FIELD_PATTERN, MESSAGE_MERGE_FIELDS, type MergeFieldKey } from "./fields";

// MSG-02 follow-up, owner's answer (90) ג (3 November 2026): a SERVICE template is limited to its type's merge fields,
// holds no external link (the system's own links come only through merge fields such as {קישור להצעה}), has a length
// cap, and is checked before every send; one that does not pass is not sent, and the business sees why.
// THE rule is app.message_template_problem(channel, message_type, subject, body) (migration service_template_rule);
// messageTemplateProblem() mirrors it, and both run tests/unit/fixtures/message-template-problems.json (unit test and
// test 291). Saving is never refused: the settings page shows the problem, and the editor warns on save.
// Every future sender (AUT-08, the quote screen, the reminder senders, the OPS-04 message.send path) calls
// assertTemplateSendable() (or app.message_template_sendable in SQL) right before it sends, and never sends on a problem.

export type TemplateProblem = "field_not_allowed" | "offer" | "glued_address" | "external_link" | "too_long";
export type ServiceMessageType = (typeof SERVICE_MESSAGE_TYPES)[number];

const NAMES: readonly MergeFieldKey[] = ["firstName", "fullName", "userName", "businessName", "businessPhone", "businessAddress"];

/** The merge fields each service type may hold (= app.message_type_fields). */
export const SERVICE_TYPE_FIELDS: Record<ServiceMessageType, readonly MergeFieldKey[]> = {
  // CAL-12: the meeting's location and the customer's personal link join date and time
  meeting_reminder: [...NAMES, "date", "time", "meetingLocation", "manageLink"],
  requested_document: [...NAMES, "document", "quoteLink", "validUntil"],
  collection: [...NAMES, "document", "amount", "dueDate"],
  verification_code: ["businessName", "verificationCode"],
  // PKG-03 (owner (127) ב): no price, link or offer; the business's name signs it (the owner's wording)
  punch_card_notice: ["firstName", "businessName", "businessPhone", "cardName", "entriesLeft", "date"],
  // SPD-04 (owner (80) א, (261) א): the business signs it; the return time
  instant_reply: ["firstName", "businessName", "businessPhone", "time"],
};

/**
 * RET-02: the types this rule judges. The service types, and the review request: a MARKETING type (a grant of the channel,
 * the caps, the envelope) whose templates are still held to a closed list of fields, no link of their own and the service
 * length cap (= app.message_notice_template_problem, migration review_requests).
 */
export type JudgedMessageType = ServiceMessageType | "review_request";

/** The merge fields each judged type may hold (= app.message_type_fields). */
export const JUDGED_TYPE_FIELDS: Record<JudgedMessageType, readonly MergeFieldKey[]> = {
  ...SERVICE_TYPE_FIELDS,
  // the business signs it; the review link comes only through its field
  review_request: ["firstName", "businessName", "businessPhone", "reviewLink"],
};

/**
 * SGN-03 review M1: the fields a template may hold only with the system's own mark (message_templates.notice_kind), on
 * top of its type's (= app.message_notice_fields). A requested_document marked 'signature_reminder' carries the document's
 * title, last day and link; no template a person writes may.
 */
export const NOTICE_KIND_FIELDS: Partial<Record<JudgedMessageType, Record<string, readonly MergeFieldKey[]>>> = {
  requested_document: { signature_reminder: ["date", "manageLink", "documentName"] },
};

function allowedFields(template: { messageType: JudgedMessageType; noticeKind?: string | null }): readonly MergeFieldKey[] {
  const extra = template.noticeKind ? (NOTICE_KIND_FIELDS[template.messageType]?.[template.noticeKind] ?? []) : [];
  return [...JUDGED_TYPE_FIELDS[template.messageType], ...extra];
}

/** A service message's body cap by channel, in characters, counted on the template as written (= app.message_service_body_max). */
export const SERVICE_BODY_MAX: Record<MessageChannel, number> = { sms: 300, whatsapp: 1000, email: 2000 };

// Owners (97) ב, (104) ב, (105) ב, (110) ב, (111) ב and the reviews of 3 November 2026: = app.message_external_link
// (migrations service_message_send_rules and message_link_tlds; their headers list what is accepted). A bare domain is a link; the business's own
// domain (organizations.website, as websiteDomain() reads it) is allowed: its registered domain and every host under it,
// or, under a shared site host, only the exact host and its www. Linear: two global scans, each part split once and
// walked once. The closed lists below are mirrored between their markers in the migration (unit test).

/** Hosts where many businesses get their own sub-site (= app.message_shared_site_host). */
export const SHARED_SITE_HOSTS: readonly string[] = [
  "wixsite.com", "wix.com", "editorx.io", "wixstudio.io", "wordpress.com", "wpcomstaging.com", "weebly.com",
  "godaddysites.com", "business.site", "square.site", "squarespace.com", "webflow.io", "netlify.app", "vercel.app",
  "pages.dev", "workers.dev", "web.app", "firebaseapp.com", "herokuapp.com", "azurewebsites.net", "onrender.com",
  "github.io", "gitlab.io", "blogspot.com", "blogspot.co.il", "myshopify.com", "tumblr.com", "carrd.co", "linktr.ee",
  "sites.google.com", "notion.site", "framer.website", "framer.app", "tilda.ws", "jimdosite.com", "webnode.page",
  "mystrikingly.com", "site123.me", "canva.site", "amazonaws.com", "cloudfront.net", "appspot.com", "fly.dev", "r2.dev",
  "ngrok-free.app", "ngrok.io", "blob.core.windows.net", "glitch.me", "repl.co", "surge.sh", "translate.goog",
];

/** URL shorteners, never a business's own domain (= app.message_url_shortener). */
export const URL_SHORTENERS: readonly string[] = [
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "cutt.ly", "rebrand.ly", "buff.ly", "tiny.cc", "rb.gy",
  "shorturl.at", "lnkd.in",
];

/** Big platforms a business has a page on but never owns (= app.message_platform_domain). */
export const PLATFORM_DOMAINS: readonly string[] = [
  "google.com", "facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "youtube.com", "wa.me", "t.me", "x.com",
  "twitter.com", "whatsapp.com",
];

/** Last labels that name a file, not a site (= app.message_file_extension); zip and mov are real TLDs and stay links. */
export const FILE_EXTENSIONS: readonly string[] = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "jpg", "jpeg", "png", "gif", "txt", "csv", "heic", "webp", "mp3",
  "mp4", "rar",
];

/**
 * Owner (110) ב: the only endings that make a bare domain a link (= app.message_link_tld), besides punycode (xn--...).
 * Generic endings and the country codes common in Israel and the world; Israel's second levels (co.il, org.il, net.il,
 * ac.il, gov.il, muni.il, k12.il, idf.il) are covered by "il". Closed: a new ending is added here and in a migration.
 */
export const LINK_TLDS: readonly string[] = [
  "com", "net", "org", "info", "biz", "io", "co", "app", "dev", "ai", "me", "tv", "xyz", "online", "site", "website",
  "store", "shop", "tech", "link", "live", "club", "top", "pro", "cloud", "edu", "gov", "mil", "int", "mobi", "name",
  "space", "blog", "news", "media", "agency", "digital", "email", "solutions", "services", "studio", "design", "page",
  "network", "group", "company", "center", "academy", "software", "systems", "marketing", "business", "finance", "bank",
  "health", "travel", "games", "social", "wiki", "host", "vip", "global", "zip", "mov", "ly", "gg", "cc", "ws", "to",
  "la", "fm", "sh", "ac", "gl", "gd", "gy", "im", "nu", "tk", "il", "us", "uk", "de", "fr", "ru", "ua", "es", "it", "nl",
  "eu", "ca", "au", "in", "cn", "jp", "br", "ch", "at", "be", "se", "no", "dk", "fi", "pl", "pt", "gr", "tr", "ie", "cz",
  "hu", "ro", "bg", "sk", "si", "hr", "rs", "lt", "lv", "ee", "by", "kz", "ge", "am", "az", "md", "ae", "sa", "eg", "jo",
  "ma", "za", "ng", "ke", "mx", "ar", "cl", "pe", "ve", "nz", "sg", "hk", "tw", "kr", "th", "vn", "my", "id", "ph", "pk",
  "cy", "mt", "lu", "is", "li", "ps", "su", "uz", "icu", "cfd", "sbs", "lat", "pw", "ml", "ga", "cf", "gq", "cam", "cyou",
  "ir", "iq", "lb",
];

const SHARED = new Set(SHARED_SITE_HOSTS);
const TLDS = new Set(LINK_TLDS);
const SHORT = new Set(URL_SHORTENERS);
const PLATFORMS = new Set(PLATFORM_DOMAINS);
const FILES = new Set(FILE_EXTENSIONS);

/** A domain may be a business's own (= app.message_own_domain_ok): a registered domain, not a shared host, free mail or shortener. */
export function ownDomainOk(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const registered = registeredDomain(domain);
  return (
    registered !== null &&
    !SHARED.has(domain) &&
    !isPublicEmailDomain(domain) &&
    !SHORT.has(domain) &&
    !SHORT.has(registered) &&
    !PLATFORMS.has(registered)
  );
}

/** A website a business may save (= app.message_website_ok): http(s) or a bare host, 300 characters, a domain it can own. */
export function websiteOk(website: string | null | undefined): boolean {
  if (website === null || website === undefined || website.length > 300) return false;
  const trimmed = website.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!/^https?:\/\//i.test(trimmed) && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  return ownDomainOk(websiteDomain(website));
}

function underSharedHost(domain: string): boolean {
  const labels = domain.split(".");
  for (let i = 0; i <= Math.max(labels.length - 2, 0); i += 1) {
    const suffix = labels.slice(i).join(".");
    if (SHARED.has(suffix) || isPublicEmailDomain(suffix)) return true;
  }
  return false;
}

/** = app.message_host_own: the host is the business's own. */
export function isOwnHost(host: string, own: string): boolean {
  if (!ownDomainOk(own)) return false;
  if (underSharedHost(own)) return host === own || host === `www.${own}`;
  const registered = registeredDomain(own) as string;
  return host === registered || host.endsWith(`.${registered}`);
}

function trimChars(value: string, chars: string, leading = true): string {
  let start = 0;
  let end = value.length;
  if (leading) while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

const LABEL = /^[a-z0-9א-תء-ي]([a-z0-9א-תء-ي-]*[a-z0-9א-תء-ي])?$/;

/** = app.message_domain_suffix: the domain a lower-case part ends in, or null. */
function domainSuffix(part: string): string | null {
  const labels = part.split(".");
  const n = labels.length;
  if (n < 2) return null;
  // a top-level label glued to Hebrew or Arabic letters ("evil.comשלום"), or joined to them by a hyphen
  // ("evil.com-שלום"), is its ASCII part
  labels[n - 1] = labels[n - 1].replace(/^([a-z]{2,63})-?[א-תء-ي]+$/, "$1");
  // owner (110) ב: only an ending on the closed list, or punycode
  if (!(TLDS.has(labels[n - 1]) || /^xn--[a-z0-9-]{1,59}$/.test(labels[n - 1])) || FILES.has(labels[n - 1])) return null;
  let length = labels[n - 1].length;
  let from = n - 1;
  for (let i = n - 2; i >= 0; i -= 1) {
    const label = labels[i];
    if (label.length < 1 || label.length > 63 || !LABEL.test(label) || length + 1 + label.length > 253) break;
    length += 1 + label.length;
    from = i;
  }
  return from === n - 1 ? null : labels.slice(from).join(".");
}

const IPV4 = /^[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}$/;

/** = app.message_part_link */
function partLink(part: string, own: string): boolean {
  // a Hebrew or Arabic prefix joined by a hyphen ("ב-biz.co.il") is not part of the host
  const value = trimChars(part, ".-").toLowerCase().replace(/^[א-תء-ي]+-/, "");
  if (value.startsWith("www.")) return !isOwnHost(value, own);
  if (IPV4.test(value) && value.split(".").every((octet) => Number(octet) <= 255)) return true;
  const domain = domainSuffix(value);
  return domain !== null && !isOwnHost(domain, own);
}

/**
 * = app.message_token_pieces: a token cut at every ending followed by Hebrew or Arabic letters, with or without a hyphen
 * between ("info@gmail.com-שלום-תודה" -> "info@gmail.com", "-שלום-תודה"); each piece is judged on its own.
 */
function tokenPieces(token: string): string[] {
  return token.replace(/([.][A-Za-z]{2,63})(-?[א-תء-ي])/g, "$1\u0002$2").split("\u0002");
}

/** = app.message_token_link: the token rule, piece by piece. */
function tokenLink(token: string, own: string, businessEmail: string | null): boolean {
  return tokenPieces(token).some((piece) => piece !== "" && tokenPieceLink(piece, own, businessEmail));
}

/**
 * = app.message_token_piece_link: an email address (exactly local@domain, a Hebrew/Arabic prefix with a hyphen and "."
 * "-" at both ends cut off) is a link when its local part is itself a host; else allowed when it is the business's plain
 * email (already through plainBusinessEmail()) or its domain is the business's own (owner (111) ב); any other piece:
 * each "@"-free part.
 */
function tokenPieceLink(token: string, own: string, businessEmail: string | null): boolean {
  const value = trimChars(asciiLower(token).replace(/^[א-תء-ي]+-/, ""), ".-");
  if (/^[^@]+@[^@]+$/.test(value)) {
    const [local, domain] = value.split("@");
    if (domainSuffix(domain) === domain) {
      if (localPartHost(local) || domainSuffix(local) !== null) return true;
      if (value === businessEmail) return false;
      return !isOwnHost(domain, own);
    }
  }
  return token.split("@").some((part) => partLink(part, own));
}

/** = app.message_authority_link: the authority after "http(s)://". */
function authorityLink(raw: string, own: string): boolean {
  // the authority runs to whitespace or / ? # \; punctuation that ends a sentence is not part of it
  const authority = trimChars(raw, ".,;:!)'\"", false);
  // review 2, item 1: a character browsers drop or map hides another host, so anything outside the plain set is a link
  if (!/^[A-Za-z0-9.:@[\]-]*$/.test(authority)) return true;
  if (authority.includes("@") || authority.startsWith("[")) return true;
  const colon = authority.indexOf(":");
  if (colon >= 0 && !/^[0-9]{1,5}$/.test(authority.slice(colon + 1))) return true;
  const host = trimChars(colon >= 0 ? authority.slice(0, colon) : authority, ".", false).toLowerCase();
  return !isOwnHost(host, own);
}

const AUTHORITY = /https?:\/\/([^ \t\r\n/?#\\]*)/gi;
const TOKEN = /[A-Za-z0-9.@א-תء-ي-]+/g;
const WIDE_DOTS = /[。．｡]/g;
// soft hyphen, zero-width characters, word joiner, BOM, direction marks, embeddings and isolates (= the chr() list in SQL)
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/** The text as the link rules read it: NFKC, invisible format characters out, wide dots as dots (= app.message_link_text). */
function linkText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").replace(WIDE_DOTS, ".");
}

/** ASCII letters to lower case, nothing else (= app.message_ascii_lower). */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/**
 * = app.message_local_host: an address's local part looks like a host. Trimmed of "." and "-", it starts with "www.", is
 * an IPv4 address, or a label after a dot starts with a listed ending (its leading letters and digits) or with xn--.
 */
export function localPartHost(local: string): boolean {
  const value = trimChars(asciiLower(local), ".-");
  if (value.startsWith("www.")) return true;
  if (IPV4.test(value) && value.split(".").every((octet) => Number(octet) <= 255)) return true;
  return value
    .split(".")
    .slice(1)
    .some((label) => label.startsWith("xn--") || TLDS.has(/^[a-z0-9]+/.exec(label)?.[0] ?? ""));
}

/**
 * Owner (111) ב and the review of 7fe2fa4: the business's email, ASCII letters folded, when it is a plain address (local
 * part of letters, digits, "." and "-", not at either end, that is no host itself; domain on the ending list); else null,
 * so a stored "https://evil.com/x@y.co" never counts (= app.message_plain_email).
 */
export function plainBusinessEmail(email: string | null | undefined): string | null {
  const value = asciiLower((email ?? "").replace(/^ +| +$/g, ""));
  // owner (114) א: an address in non-Latin letters is never the business email
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?@[^@]+$/.test(value) || !/^[\x21-\x7e]+$/.test(value)) return null;
  const [local, domain] = value.split("@");
  if (domainSuffix(domain) !== domain || value.includes("..") || localPartHost(local) || domainSuffix(local) !== null) return null;
  return value;
}

/** True when the text holds a link that is not the business's own domain or its own email (= app.message_external_link). */
export function messageExternalLink(text: string, ownDomain: string | null = null, businessEmail: string | null = null): boolean {
  const value = linkText(text);
  const own = (ownDomain ?? "").trim().toLowerCase();
  const email = plainBusinessEmail(businessEmail);
  // the scheme scan comes first and knows nothing of the business email ("https://info@gmail.com" stays a link)
  for (const match of value.matchAll(AUTHORITY)) if (authorityLink(match[1], own)) return true;
  for (const match of value.matchAll(TOKEN)) if (tokenLink(match[0], own, email)) return true;
  return false;
}

// Owner (113) א (3 November 2026): the business email is recognised only in its exact form, with a word boundary; an
// address glued to text is another address, and the template is stopped with its own code, glued_address. = the rule of
// migration glued_address (its header says exactly which tokens are glued); both run the shared fixture.

/**
 * Code points above ASCII that do NOT glue an address, as inclusive [from, to] pairs (= app.message_glue_boundary,
 * between the markers glue-boundaries:start/end; unit test): spaces, punctuation, quotes, dashes, symbols, arrows,
 * currency, emoji. Any other character above ASCII next to an address (a letter or digit of any script, a point) glues it.
 */
export const GLUE_BOUNDARY_RANGES: readonly (readonly [number, number])[] = [
  [160, 191], [215, 215], [247, 247], [1470, 1470], [1472, 1472], [1475, 1475], [1523, 1524], [1548, 1548], [1563, 1563],
  [1567, 1567], [1642, 1645], [1748, 1748], [8192, 8303], [8352, 8399], [8592, 11263], [12288, 12291], [12296, 12305],
  [65024, 65039], [126976, 129791],
];

/** A merge field written right next to an address glues it once filled ("{שם}info@..."). */
const GLUE_ASCII = "{}";
/** "*", "~", "'" and "_" around the business email pass only as a pair (WhatsApp formatting and quotes). */
const MARKS = "*~'_";
/** Other characters an address may hold that the tokens split on: right before the business email, another address. */
const ADDRESS_BEFORE = "!#$%&+/=?^`|";
const ATEXT = "!#$%&'*+/=?^_`{|}~";

/** = app.message_glue_char: the text's character directly next to an address glues it. */
function glueChar(char: string): boolean {
  if (char === "") return false;
  const code = char.codePointAt(0) as number;
  if (code <= 127) return GLUE_ASCII.includes(char);
  return !GLUE_BOUNDARY_RANGES.some(([from, to]) => code >= from && code <= to);
}

/** = app.message_mark_outer_ok: the character outside a formatting pair ends it (no address character). */
function markOuterOk(char: string, close: boolean): boolean {
  if (char === "") return true;
  const code = char.codePointAt(0) as number;
  if (code <= 127) return (!/[A-Za-z0-9.@-]/.test(char) && !ATEXT.includes(char)) || (close && ".!?".includes(char));
  return !/[א-תء-ي]/.test(char) && !glueChar(char);
}

const PLACEHOLDER = "\u0001";
const TOUCHES_PLACEHOLDER = /[a-z0-9א-תء-ي]\u0001|\u0001[a-z0-9א-תء-ي]/;
const MIXED_SCRIPT = /[א-תء-ي][a-z0-9]|[a-z0-9][א-תء-ي]/;
const DASH_ENDING = /[.][a-z]{2,63}-[a-z0-9-]+$/;

type Glue = "glued" | "other" | null;

/** = app.message_own_address: a well-formed address on the business's own domain (the link rule allows it). */
function ownAddress(value: string, own: string): boolean {
  if (!/^[^@]+@[^@]+$/.test(value)) return false;
  const [local, domain] = value.split("@");
  return domainSuffix(domain) === domain && !localPartHost(local) && domainSuffix(local) === null && isOwnHost(domain, own);
}

type Around = { before: string; after: string; outerBefore: string; outerAfter: string };

/**
 * = app.message_glued_token: one piece holding "@", the characters of the text next to it (and outside those), the own
 * domain (lower-cased, trimmed) and the plain business email (or null). "glued" = an address glued to text; "other" = an
 * address that is a link ((c) the business email made into a longer address, (d) an ending followed by "-" and letters or
 * digits); null = neither. Cheap string tests first.
 */
function gluedToken(token: string, around: Around, own: string, businessEmail: string | null): Glue {
  const { before, after } = around;
  const lowered = asciiLower(token);
  const cut = lowered.replace(/^[א-תء-ي]+-/, "");
  const value = trimChars(cut, ".-");
  // (a) the business email with a letter or digit touching it, unless the piece is itself an allowed own-domain address
  if (
    businessEmail !== null &&
    value !== businessEmail &&
    value.includes(businessEmail) &&
    TOUCHES_PLACEHOLDER.test(value.split(businessEmail).join(PLACEHOLDER)) &&
    !ownAddress(value, own)
  ) {
    return "glued";
  }
  if (!/^[^@]+@[^@]+$/.test(value)) return null;
  const startKept = cut === lowered && cut[0] !== "." && cut[0] !== "-";
  const endKept = cut.length > 0 && cut[cut.length - 1] !== "." && cut[cut.length - 1] !== "-";
  // (b1) Hebrew or Arabic letters touching ASCII letters or digits; (b2) the text's character next to the piece
  const mixed = MIXED_SCRIPT.test(value);
  const side = (startKept && glueChar(before)) || (endKept && glueChar(after));
  // (c) the business email next to an address character; the four marks pass only as a pair with nothing outside it
  let other = false;
  if (value === businessEmail) {
    const markBefore = startKept && before !== "" && MARKS.includes(before);
    const markAfter = endKept && after !== "" && MARKS.includes(after);
    if (markBefore || markAfter) {
      other = !(markBefore && markAfter && before === after && markOuterOk(around.outerBefore, false) && markOuterOk(around.outerAfter, true));
    } else {
      other = startKept && before !== "" && ADDRESS_BEFORE.includes(before);
    }
  }
  // (d) an ending followed by "-" and ASCII letters or digits ("dana@evil.com-x")
  const domain = value.split("@")[1];
  const dash = DASH_ENDING.test(domain);
  if (!(mixed || side || other || dash)) return null;
  if ((mixed || side) && domainSuffix(domain) !== null) return "glued";
  if (other && domainSuffix(domain) === domain && !ownAddress(value, own)) return "other";
  if (dash) {
    const bare = domain.replace(/-[a-z0-9-]+$/, "");
    if (domainSuffix(bare) === bare && !isOwnHost(bare, own)) return "other";
  }
  return null;
}

/** The whole code point that ends just before index i (a surrogate pair counts as one). */
function charBefore(value: string, i: number): string {
  if (i <= 0) return "";
  const low = value.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = value.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return value.slice(i - 2, i);
  }
  return value[i - 1];
}

/** The whole code point that starts at index i, or "". */
function charAt(value: string, i: number): string {
  return i < value.length ? String.fromCodePoint(value.codePointAt(i) as number) : "";
}

/**
 * = app.message_address_glue: "glued_address" at the first address glued to text; else "external_link" when an address
 * is a link the token rule does not see ((c), (d)) or a listed ending follows a letter outside ASCII, Hebrew and Arabic
 * with no space ((e): "x@café.com", "evilж.com"; fail closed); else null. A token holding "@" is judged piece by piece.
 */
export function messageAddressGlue(
  text: string,
  ownDomain: string | null = null,
  businessEmail: string | null = null,
): "glued_address" | "external_link" | null {
  const value = linkText(text);
  const own = (ownDomain ?? "").trim().toLowerCase();
  const email = plainBusinessEmail(businessEmail);
  let link = false;
  for (const match of value.matchAll(TOKEN)) {
    const token = match[0];
    const start = match.index;
    const before = charBefore(value, start);
    // (e) a listed ending right after a letter of another script
    if (
      !link &&
      token.startsWith(".") &&
      before !== "" &&
      (before.codePointAt(0) as number) > 127 &&
      glueChar(before) &&
      domainSuffix(`x${asciiLower(token)}`) !== null
    ) {
      link = true;
    }
    if (!token.includes("@")) continue;
    const end = start + token.length;
    const after = charAt(value, end);
    const outerBefore = before === "" ? "" : charBefore(value, start - before.length);
    const outerAfter = after === "" ? "" : charAt(value, end + after.length);
    const pieces = tokenPieces(token);
    for (let i = 0; i < pieces.length; i += 1) {
      if (!pieces[i].includes("@")) continue;
      const around: Around = {
        before: i === 0 ? before : pieces[i - 1].slice(-1),
        after: i === pieces.length - 1 ? after : charAt(pieces[i + 1], 0),
        outerBefore: i === 0 ? outerBefore : "",
        outerAfter: i === pieces.length - 1 ? outerAfter : "",
      };
      const glue = gluedToken(pieces[i], around, own, email);
      if (glue === "glued") return "glued_address";
      if (glue === "other") link = true;
    }
  }
  return link ? "external_link" : null;
}

function isService(type: MessageType): type is ServiceMessageType {
  return (SERVICE_MESSAGE_TYPES as readonly string[]).includes(type);
}

/** A type this rule judges: a service type, or the review request (RET-02). */
export function isJudgedType(type: MessageType): type is JudgedMessageType {
  return isService(type) || type === "review_request";
}

function fieldName(key: MergeFieldKey): string {
  return MESSAGE_MERGE_FIELDS[key].token.slice(1, -1);
}

export type TemplateText = {
  channel: MessageChannel;
  messageType: MessageType;
  subject: string | null;
  body: string;
  /** the business's own domain (websiteDomain of organizations.website); its links are allowed */
  ownDomain?: string | null;
  /** owner (111) ב: the business's own email (org_document_settings.email); it may appear in a service message */
  businessEmail?: string | null;
  /** SGN-03 review M1: the system's own mark (message_templates.notice_kind), null for a template a person writes */
  noticeKind?: string | null;
};

/** The business's own addresses a service message may hold (owners (105), (111)): its website's domain and its email. */
export type OwnAddresses = { ownDomain: string | null; businessEmail: string | null };

/** Every {field} of the template that its service type may not hold, in order, each once; [] for marketing. */
export function fieldsNotAllowed(template: TemplateText): string[] {
  if (!isJudgedType(template.messageType)) return [];
  const allowed = new Set(allowedFields({ messageType: template.messageType, noticeKind: template.noticeKind }).map(fieldName));
  const found = new Set<string>();
  for (const match of `${template.subject ?? ""}\n${template.body}`.matchAll(MERGE_FIELD_PATTERN)) {
    if (!allowed.has(match[1])) found.add(match[0]);
  }
  return [...found];
}

// SPD-04, owner (282) ב (11 November 2026): an instant reply holds no price, percent discount or marketing word, and saving
// one that does is refused (with an external link too). = app.message_offer (migration instant_reply_editable, whose header
// lists the rule step by step); both run the shared fixture message-template-problems.json. It judges the template's text as
// written, never the filled fields.

/** The closed list of marketing words (= app.message_offer_words; mirrored between the markers, unit test). */
export const OFFER_WORDS: readonly string[] = [
  // offer-words:start
  "במבצע", "חינם", "מחיר", "מחירים", "הטבה", "הטבות", "קופון", "קופונים", "בלעדי", "בלעדית", "בלעדיים",
  "בלעדיות", "אחוז", "אחוזים", "שקל", "שקלים", "דולר", "דולרים", "יורו", "nis", "ils", "usd", "eur", "sale", "discount",
  "coupon", "promo",
  // offer-words:end
];

/** Ordinary words a prefix letter and a list word make (= app.message_offer_not_words): "משקל" is weight, "לאחוז" to hold. */
export const OFFER_NOT_WORDS: readonly string[] = [
  // offer-not-words:start
  "משקל", "משקלים", "לאחוז",
  // offer-not-words:end
];

/** Cyrillic and Greek look-alikes of Latin letters, folded one to one (= the two strings of app.message_offer). */
// offer-fold:start
export const OFFER_FOLD_FROM = "аАвВеЕёЁкКмМнНоОрРсСтТуУхХіІјЈѕЅԁԀӏӀαΑβΒεΕηΗιΙκΚμΜνΝοΟρΡτΤυΥχΧΖ";
export const OFFER_FOLD_TO = "aabbeeeekkmmhhooppccttyyxxiijjssddllaabbeenhiikkumvnooppttuyxxz";
// offer-fold:end

/** The format characters (Unicode Cf) the rule removes, as code point ranges (= app.message_offer's list; unit test). */
export const OFFER_CF_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xad, 0xad], [0x600, 0x605], [0x61c, 0x61c], [0x6dd, 0x6dd], [0x70f, 0x70f], [0x890, 0x891], [0x8e2, 0x8e2],
  [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff],
  [0xfff9, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001], [0xe0020, 0xe007f],
];

/** Every combining mark (Unicode Mn) the rule removes, as code point ranges (= app.message_offer's list; unit test). */
export const OFFER_MN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x300, 0x36f], [0x483, 0x487], [0x591, 0x5bd], [0x5bf, 0x5bf], [0x5c1, 0x5c2], [0x5c4, 0x5c5],
  [0x5c7, 0x5c7], [0x610, 0x61a], [0x64b, 0x65f], [0x670, 0x670], [0x6d6, 0x6dc], [0x6df, 0x6e4],
  [0x6e7, 0x6e8], [0x6ea, 0x6ed], [0x711, 0x711], [0x730, 0x74a], [0x7a6, 0x7b0], [0x7eb, 0x7f3],
  [0x7fd, 0x7fd], [0x816, 0x819], [0x81b, 0x823], [0x825, 0x827], [0x829, 0x82d], [0x859, 0x85b],
  [0x897, 0x89f], [0x8ca, 0x8e1], [0x8e3, 0x902], [0x93a, 0x93a], [0x93c, 0x93c], [0x941, 0x948],
  [0x94d, 0x94d], [0x951, 0x957], [0x962, 0x963], [0x981, 0x981], [0x9bc, 0x9bc], [0x9c1, 0x9c4],
  [0x9cd, 0x9cd], [0x9e2, 0x9e3], [0x9fe, 0x9fe], [0xa01, 0xa02], [0xa3c, 0xa3c], [0xa41, 0xa42],
  [0xa47, 0xa48], [0xa4b, 0xa4d], [0xa51, 0xa51], [0xa70, 0xa71], [0xa75, 0xa75], [0xa81, 0xa82],
  [0xabc, 0xabc], [0xac1, 0xac5], [0xac7, 0xac8], [0xacd, 0xacd], [0xae2, 0xae3], [0xafa, 0xaff],
  [0xb01, 0xb01], [0xb3c, 0xb3c], [0xb3f, 0xb3f], [0xb41, 0xb44], [0xb4d, 0xb4d], [0xb55, 0xb56],
  [0xb62, 0xb63], [0xb82, 0xb82], [0xbc0, 0xbc0], [0xbcd, 0xbcd], [0xc00, 0xc00], [0xc04, 0xc04],
  [0xc3c, 0xc3c], [0xc3e, 0xc40], [0xc46, 0xc48], [0xc4a, 0xc4d], [0xc55, 0xc56], [0xc62, 0xc63],
  [0xc81, 0xc81], [0xcbc, 0xcbc], [0xcbf, 0xcbf], [0xcc6, 0xcc6], [0xccc, 0xccd], [0xce2, 0xce3],
  [0xd00, 0xd01], [0xd3b, 0xd3c], [0xd41, 0xd44], [0xd4d, 0xd4d], [0xd62, 0xd63], [0xd81, 0xd81],
  [0xdca, 0xdca], [0xdd2, 0xdd4], [0xdd6, 0xdd6], [0xe31, 0xe31], [0xe34, 0xe3a], [0xe47, 0xe4e],
  [0xeb1, 0xeb1], [0xeb4, 0xebc], [0xec8, 0xece], [0xf18, 0xf19], [0xf35, 0xf35], [0xf37, 0xf37],
  [0xf39, 0xf39], [0xf71, 0xf7e], [0xf80, 0xf84], [0xf86, 0xf87], [0xf8d, 0xf97], [0xf99, 0xfbc],
  [0xfc6, 0xfc6], [0x102d, 0x1030], [0x1032, 0x1037], [0x1039, 0x103a], [0x103d, 0x103e], [0x1058, 0x1059],
  [0x105e, 0x1060], [0x1071, 0x1074], [0x1082, 0x1082], [0x1085, 0x1086], [0x108d, 0x108d], [0x109d, 0x109d],
  [0x135d, 0x135f], [0x1712, 0x1714], [0x1732, 0x1733], [0x1752, 0x1753], [0x1772, 0x1773], [0x17b4, 0x17b5],
  [0x17b7, 0x17bd], [0x17c6, 0x17c6], [0x17c9, 0x17d3], [0x17dd, 0x17dd], [0x180b, 0x180d], [0x180f, 0x180f],
  [0x1885, 0x1886], [0x18a9, 0x18a9], [0x1920, 0x1922], [0x1927, 0x1928], [0x1932, 0x1932], [0x1939, 0x193b],
  [0x1a17, 0x1a18], [0x1a1b, 0x1a1b], [0x1a56, 0x1a56], [0x1a58, 0x1a5e], [0x1a60, 0x1a60], [0x1a62, 0x1a62],
  [0x1a65, 0x1a6c], [0x1a73, 0x1a7c], [0x1a7f, 0x1a7f], [0x1ab0, 0x1abd], [0x1abf, 0x1add], [0x1ae0, 0x1aeb],
  [0x1b00, 0x1b03], [0x1b34, 0x1b34], [0x1b36, 0x1b3a], [0x1b3c, 0x1b3c], [0x1b42, 0x1b42], [0x1b6b, 0x1b73],
  [0x1b80, 0x1b81], [0x1ba2, 0x1ba5], [0x1ba8, 0x1ba9], [0x1bab, 0x1bad], [0x1be6, 0x1be6], [0x1be8, 0x1be9],
  [0x1bed, 0x1bed], [0x1bef, 0x1bf1], [0x1c2c, 0x1c33], [0x1c36, 0x1c37], [0x1cd0, 0x1cd2], [0x1cd4, 0x1ce0],
  [0x1ce2, 0x1ce8], [0x1ced, 0x1ced], [0x1cf4, 0x1cf4], [0x1cf8, 0x1cf9], [0x1dc0, 0x1dff], [0x20d0, 0x20dc],
  [0x20e1, 0x20e1], [0x20e5, 0x20f0], [0x2cef, 0x2cf1], [0x2d7f, 0x2d7f], [0x2de0, 0x2dff], [0x302a, 0x302d],
  [0x3099, 0x309a], [0xa66f, 0xa66f], [0xa674, 0xa67d], [0xa69e, 0xa69f], [0xa6f0, 0xa6f1], [0xa802, 0xa802],
  [0xa806, 0xa806], [0xa80b, 0xa80b], [0xa825, 0xa826], [0xa82c, 0xa82c], [0xa8c4, 0xa8c5], [0xa8e0, 0xa8f1],
  [0xa8ff, 0xa8ff], [0xa926, 0xa92d], [0xa947, 0xa951], [0xa980, 0xa982], [0xa9b3, 0xa9b3], [0xa9b6, 0xa9b9],
  [0xa9bc, 0xa9bd], [0xa9e5, 0xa9e5], [0xaa29, 0xaa2e], [0xaa31, 0xaa32], [0xaa35, 0xaa36], [0xaa43, 0xaa43],
  [0xaa4c, 0xaa4c], [0xaa7c, 0xaa7c], [0xaab0, 0xaab0], [0xaab2, 0xaab4], [0xaab7, 0xaab8], [0xaabe, 0xaabf],
  [0xaac1, 0xaac1], [0xaaec, 0xaaed], [0xaaf6, 0xaaf6], [0xabe5, 0xabe5], [0xabe8, 0xabe8], [0xabed, 0xabed],
  [0xfb1e, 0xfb1e], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0x101fd, 0x101fd], [0x102e0, 0x102e0], [0x10376, 0x1037a],
  [0x10a01, 0x10a03], [0x10a05, 0x10a06], [0x10a0c, 0x10a0f], [0x10a38, 0x10a3a], [0x10a3f, 0x10a3f], [0x10ae5, 0x10ae6],
  [0x10d24, 0x10d27], [0x10d69, 0x10d6d], [0x10eab, 0x10eac], [0x10efa, 0x10eff], [0x10f46, 0x10f50], [0x10f82, 0x10f85],
  [0x11001, 0x11001], [0x11038, 0x11046], [0x11070, 0x11070], [0x11073, 0x11074], [0x1107f, 0x11081], [0x110b3, 0x110b6],
  [0x110b9, 0x110ba], [0x110c2, 0x110c2], [0x11100, 0x11102], [0x11127, 0x1112b], [0x1112d, 0x11134], [0x11173, 0x11173],
  [0x11180, 0x11181], [0x111b6, 0x111be], [0x111c9, 0x111cc], [0x111cf, 0x111cf], [0x1122f, 0x11231], [0x11234, 0x11234],
  [0x11236, 0x11237], [0x1123e, 0x1123e], [0x11241, 0x11241], [0x112df, 0x112df], [0x112e3, 0x112ea], [0x11300, 0x11301],
  [0x1133b, 0x1133c], [0x11340, 0x11340], [0x11366, 0x1136c], [0x11370, 0x11374], [0x113bb, 0x113c0], [0x113ce, 0x113ce],
  [0x113d0, 0x113d0], [0x113d2, 0x113d2], [0x113e1, 0x113e2], [0x11438, 0x1143f], [0x11442, 0x11444], [0x11446, 0x11446],
  [0x1145e, 0x1145e], [0x114b3, 0x114b8], [0x114ba, 0x114ba], [0x114bf, 0x114c0], [0x114c2, 0x114c3], [0x115b2, 0x115b5],
  [0x115bc, 0x115bd], [0x115bf, 0x115c0], [0x115dc, 0x115dd], [0x11633, 0x1163a], [0x1163d, 0x1163d], [0x1163f, 0x11640],
  [0x116ab, 0x116ab], [0x116ad, 0x116ad], [0x116b0, 0x116b5], [0x116b7, 0x116b7], [0x1171d, 0x1171d], [0x1171f, 0x1171f],
  [0x11722, 0x11725], [0x11727, 0x1172b], [0x1182f, 0x11837], [0x11839, 0x1183a], [0x1193b, 0x1193c], [0x1193e, 0x1193e],
  [0x11943, 0x11943], [0x119d4, 0x119d7], [0x119da, 0x119db], [0x119e0, 0x119e0], [0x11a01, 0x11a0a], [0x11a33, 0x11a38],
  [0x11a3b, 0x11a3e], [0x11a47, 0x11a47], [0x11a51, 0x11a56], [0x11a59, 0x11a5b], [0x11a8a, 0x11a96], [0x11a98, 0x11a99],
  [0x11b60, 0x11b60], [0x11b62, 0x11b64], [0x11b66, 0x11b66], [0x11c30, 0x11c36], [0x11c38, 0x11c3d], [0x11c3f, 0x11c3f],
  [0x11c92, 0x11ca7], [0x11caa, 0x11cb0], [0x11cb2, 0x11cb3], [0x11cb5, 0x11cb6], [0x11d31, 0x11d36], [0x11d3a, 0x11d3a],
  [0x11d3c, 0x11d3d], [0x11d3f, 0x11d45], [0x11d47, 0x11d47], [0x11d90, 0x11d91], [0x11d95, 0x11d95], [0x11d97, 0x11d97],
  [0x11ef3, 0x11ef4], [0x11f00, 0x11f01], [0x11f36, 0x11f3a], [0x11f40, 0x11f40], [0x11f42, 0x11f42], [0x11f5a, 0x11f5a],
  [0x13440, 0x13440], [0x13447, 0x13455], [0x1611e, 0x16129], [0x1612d, 0x1612f], [0x16af0, 0x16af4], [0x16b30, 0x16b36],
  [0x16f4f, 0x16f4f], [0x16f8f, 0x16f92], [0x16fe4, 0x16fe4], [0x1bc9d, 0x1bc9e], [0x1cf00, 0x1cf2d], [0x1cf30, 0x1cf46],
  [0x1d167, 0x1d169], [0x1d17b, 0x1d182], [0x1d185, 0x1d18b], [0x1d1aa, 0x1d1ad], [0x1d242, 0x1d244], [0x1da00, 0x1da36],
  [0x1da3b, 0x1da6c], [0x1da75, 0x1da75], [0x1da84, 0x1da84], [0x1da9b, 0x1da9f], [0x1daa1, 0x1daaf], [0x1e000, 0x1e006],
  [0x1e008, 0x1e018], [0x1e01b, 0x1e021], [0x1e023, 0x1e024], [0x1e026, 0x1e02a], [0x1e08f, 0x1e08f], [0x1e130, 0x1e136],
  [0x1e2ae, 0x1e2ae], [0x1e2ec, 0x1e2ef], [0x1e4ec, 0x1e4ef], [0x1e5ee, 0x1e5ef], [0x1e6e3, 0x1e6e3], [0x1e6e6, 0x1e6e6],
  [0x1e6ee, 0x1e6ef], [0x1e6f5, 0x1e6f5], [0x1e8d0, 0x1e8d6], [0x1e944, 0x1e94a], [0xe0100, 0xe01ef],
];

/** The Hebrew sof pasuq and the invisible fillers, also removed (= app.message_offer). */
export const OFFER_EXTRA_STRIP: readonly number[] = [0x5c3, 0x115f, 0x1160, 0x3164, 0x2800];

/** The Arabic-Indic and Extended Arabic-Indic digits, folded to 0-9 (= the two strings of app.message_offer). */
// offer-digits:start
export const OFFER_DIGITS_FROM = "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹";
export const OFFER_DIGITS_TO = "01234567890123456789";
// offer-digits:end

const OFFER_SET = new Set(OFFER_WORDS);
const OFFER_NOT_SET = new Set(OFFER_NOT_WORDS);
const OFFER_PREFIX = "ובלהשכמ";
const OFFER_FOLD = new Map([
  ...[...OFFER_FOLD_FROM].map((ch, i) => [ch, [...OFFER_FOLD_TO][i]] as const),
  ...[...OFFER_DIGITS_FROM].map((ch, i) => [ch, OFFER_DIGITS_TO[i]] as const),
]);
const offerRange = ([a, b]: readonly [number, number]) =>
  a === b ? `\\u{${a.toString(16)}}` : `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`;
const OFFER_STRIP = new RegExp(
  `[${[...OFFER_CF_RANGES, ...OFFER_MN_RANGES].map(offerRange).join("")}${OFFER_EXTRA_STRIP.map((cp) => offerRange([cp, cp])).join("")}]`,
  "gu",
);
const OFFER_SPACE = /[\t-\r\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;
const OFFER_CURRENCY = /[\u20AA$\u20AC\u00A3]/;
const OFFER_SHEKEL = /\u05E9["'\u05F4\u05F3\u201C\u201D\u201E\u2033\u2032\u2018\u2019]{1,2}\u05D7/;
const OFFER_BARE_SHEKEL = /[0-9] *\u05E9\u05D7([^\u05D0-\u05EA]|$)|(^|[^\u05D0-\u05EA])\u05E9\u05D7 *[0-9]/;
const OFFER_PERCENT = /[0-9] *[%\u066A]|[%\u066A] *[0-9]/;
// owner (305) ב: "הנחה" counts only in a phrase: "הנחה של" or a percent sign before it; "רק היום" counts as a phrase. The first
// word may carry up to three prefix letters (= the phrase scans of app.message_offer).
const OFFER_PHRASES = [
  /(^|[^\u05D0-\u05EA])[ובלהשכמ]{0,3}הנחה +של([^\u05D0-\u05EA]|$)/,
  /[%\u066A] *[ובלהשכמ]{0,3}הנחה([^\u05D0-\u05EA]|$)/,
  /(^|[^\u05D0-\u05EA])[ובלהשכמ]{0,3}רק +היום([^\u05D0-\u05EA]|$)/,
];
const OFFER_WORD = /[\u05D0-\u05EA]+|[a-z]+/g;

/** The rule's plain text: NFKC, format characters and niqqud out, whitespace to spaces, look-alikes folded, ASCII lower case. */
export function offerPlainText(text: string): string {
  const stripped = text.normalize("NFKC").replace(OFFER_STRIP, "").replace(OFFER_SPACE, " ");
  return asciiLower([...stripped].map((ch) => OFFER_FOLD.get(ch) ?? ch).join(""));
}

function offerWord(word: string): boolean {
  const chars = [...word];
  for (let k = 0; k <= 3 && k < chars.length; k += 1) {
    if (k > 0 && !OFFER_PREFIX.includes(chars[k - 1])) return false;
    const rest = chars.slice(k).join("");
    if (OFFER_SET.has(rest) && (k === 0 || !OFFER_NOT_SET.has(chars[k - 1] + rest))) return true;
  }
  return false;
}

/** Whether a text reads as an offer (= app.message_offer; the migration's header lists the rule). */
export function messageOffer(text: string): boolean {
  if (!text) return false;
  const plain = offerPlainText(text);
  if (OFFER_CURRENCY.test(plain) || OFFER_SHEKEL.test(plain) || OFFER_BARE_SHEKEL.test(plain) || OFFER_PERCENT.test(plain)) return true;
  if (OFFER_PHRASES.some((phrase) => phrase.test(plain))) return true;
  for (const match of plain.matchAll(OFFER_WORD)) {
    if (offerWord(match[0])) return true;
  }
  return false;
}

/**
 * Owner (282) ב: why saving an instant_reply template is refused ('offer' or 'external_link'), null when it may be saved
 * and for every other type (= app.instant_reply_template_refusal, which the trigger message_templates_instant_reply asks).
 */
export function instantReplyRefusal(template: TemplateText): "offer" | "external_link" | null {
  if (template.messageType !== "instant_reply") return null;
  const text = `${template.subject ?? ""}\n${template.body}`;
  if (messageOffer(text)) return "offer";
  const own = template.ownDomain ?? null;
  const email = template.businessEmail ?? null;
  if (messageAddressGlue(text, own, email) === "external_link" || messageExternalLink(text, own, email)) return "external_link";
  return null;
}

/** null when the template may be sent; else the first problem, in the database's order. Marketing is never judged here. */
export function messageTemplateProblem(template: TemplateText): TemplateProblem | null {
  if (!isJudgedType(template.messageType)) return null;
  if (fieldsNotAllowed(template).length > 0) return "field_not_allowed";
  const text = `${template.subject ?? ""}\n${template.body}`;
  // SPD-04 (282) ב: judged for an instant reply only
  if (template.messageType === "instant_reply" && messageOffer(text)) return "offer";
  const glue = messageAddressGlue(text, template.ownDomain ?? null, template.businessEmail ?? null);
  if (glue === "glued_address") return "glued_address";
  if (glue === "external_link" || messageExternalLink(text, template.ownDomain ?? null, template.businessEmail ?? null)) {
    return "external_link";
  }
  if ([...template.body].length > SERVICE_BODY_MAX[template.channel]) return "too_long";
  return null;
}

/**
 * SGN-03 delta review D1: the editor's and the save's answer for a template as written, judged with its stored mark
 * (message_templates.notice_kind, server only), so a seeded system template is judged by its own fields.
 */
export function editedTemplateProblemText(
  values: { channel: MessageChannel; messageType: MessageType; subject: string | null; body: string },
  noticeKind: string | null | undefined,
  own: Partial<OwnAddresses>,
): string | null {
  return templateProblemText({ ...values, ...own, noticeKind: noticeKind ?? null });
}

/** Why the template will not be sent, in Hebrew, for the settings page and the editor; null when it may be sent. */
export function templateProblemText(template: TemplateText): string | null {
  const problem = messageTemplateProblem(template);
  if (!problem || !isJudgedType(template.messageType)) return null;
  // RET-02: a review request is a marketing message held to the same rule
  const inKind = isService(template.messageType) ? "בהודעת שירות" : "בבקשת ביקורת";
  // SPD-04 (282) ב: an instant reply with an offer or an external link is not saved at all
  if (problem === "offer") return INSTANT_REPLY_OFFER;
  if (problem === "external_link" && template.messageType === "instant_reply") return INSTANT_REPLY_LINK;
  if (problem === "field_not_allowed") {
    const allowed = allowedFields({ messageType: template.messageType, noticeKind: template.noticeKind })
      .map((key) => MESSAGE_MERGE_FIELDS[key].token)
      .join(" ");
    return `התבנית לא תישלח: ${inKind} מהסוג הזה אפשר להשתמש רק בשדות ${allowed}. צריך להוריד את ${fieldsNotAllowed(template).join(", ")}.`;
  }
  if (problem === "glued_address") {
    return "התבנית לא תישלח: הכתובת צמודה לטקסט. צריך להפריד אותה ברווח מהמילים שלפניה ואחריה.";
  }
  if (problem === "external_link") {
    // owner (111) ב: an email address is allowed only on the business's own domain, or the business's own email
    const email = template.businessEmail?.trim() ? `, ואימייל רק בדומיין הזה או האימייל של העסק (${template.businessEmail.trim()})` : ", ואימייל רק בדומיין הזה";
    return ownDomainOk(template.ownDomain)
      ? `התבנית לא תישלח: ${inKind} אפשר לכתוב רק כתובות של האתר של העסק (${template.ownDomain})${email}. המערכת מוסיפה את הקישורים שלה דרך השדות, למשל {קישור להצעה}.`
      : `התבנית לא תישלח: ${inKind} אי אפשר לכתוב קישור, כתובת אתר או אימייל${template.businessEmail?.trim() ? ` מלבד האימייל של העסק (${template.businessEmail.trim()})` : ""}. המערכת מוסיפה את הקישורים שלה דרך השדות, למשל {קישור להצעה}. כתובת האתר של העסק מותרת אחרי שממלאים אותה בפרטי העסק.`;
  }
  const max = SERVICE_BODY_MAX[template.channel];
  return `התבנית לא תישלח: ${isService(template.messageType) ? "הודעת שירות" : "בקשת ביקורת"} בערוץ הזה יכולה להיות עד ${max.toLocaleString("he-IL")} תווים, והנוסח ארוך יותר (${[...template.body].length.toLocaleString("he-IL")}).`;
}

export class TemplateNotSendableError extends Error {
  constructor(readonly problem: TemplateProblem | "inactive") {
    super(`message template is not sendable: ${problem}`);
    this.name = "TemplateNotSendableError";
  }
}

/** For every future sender, right before it sends: throws when the template must not go out (inactive, or a problem). */
export function assertTemplateSendable(template: TemplateText & { isActive: boolean }): void {
  if (!template.isActive) throw new TemplateNotSendableError("inactive");
  const problem = messageTemplateProblem(template);
  if (problem) throw new TemplateNotSendableError(problem);
}

// Owners (96) א + ג and (102) ג: the length is checked again on the FILLED text, at send time. Over the cap = not sent,
// logged as "ארוכה מדי" (provider_error_code 'too_long', no provider, in the message log) and the owners and admins are
// told (the database, app.message_send_refused); never truncated. A service type against SERVICE_BODY_MAX; every other
// type against MARKETING_BODY_MAX on the ENVELOPED body (what the system adds counts). = app.message_filled_problem.
export type FilledMessage = { channel: MessageChannel; messageType: MessageType; subject: string | null; body: string };

/** A marketing message's body cap by channel, counted on the enveloped, filled body (= app.message_marketing_body_max). */
export const MARKETING_BODY_MAX: Record<MessageChannel, number> = { sms: 600, whatsapp: 2000, email: 20000 };

/** null when the message, as it goes out, may be sent; "too_long" when its body passes its channel's cap. */
export function messageFilledProblem(message: FilledMessage): "too_long" | null {
  const max = isService(message.messageType) ? SERVICE_BODY_MAX[message.channel] : MARKETING_BODY_MAX[message.channel];
  return [...message.body].length > max ? "too_long" : null;
}

/** For a sender: the template's text through marketingEnvelope(), then the fields filled, then messageFilledProblem(). */
export function envelopedFilledProblem(message: EnvelopeInput, fill: (text: string) => string): "too_long" | null {
  const enveloped = marketingEnvelope(message);
  return messageFilledProblem({
    channel: message.channel,
    messageType: message.messageType,
    subject: enveloped.subject === null ? null : fill(enveloped.subject),
    body: fill(enveloped.body),
  });
}

/** The short Hebrew label of a refusal code a sender records (the timeline, the message log). */
export const SEND_REFUSAL_LABELS: Record<TemplateProblem | "inactive", string> = {
  too_long: "ארוכה מדי",
  field_not_allowed: "שדה שלא מתאים לסוג ההודעה",
  glued_address: "כתובת צמודה לטקסט",
  external_link: "קישור חיצוני",
  offer: "מחיר או מילה שיווקית",
  inactive: "התבנית כבויה",
};
