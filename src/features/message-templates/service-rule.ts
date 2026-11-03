import { isPublicEmailDomain, registeredDomain, websiteDomain } from "@/features/company-domain/domains";
import { SERVICE_MESSAGE_TYPES, type MessageChannel, type MessageType } from "@/features/messaging/providers/types";

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

export type TemplateProblem = "field_not_allowed" | "external_link" | "too_long";
export type ServiceMessageType = (typeof SERVICE_MESSAGE_TYPES)[number];

const NAMES: readonly MergeFieldKey[] = ["firstName", "fullName", "userName", "businessName", "businessPhone", "businessAddress"];

/** The merge fields each service type may hold (= app.message_type_fields). */
export const SERVICE_TYPE_FIELDS: Record<ServiceMessageType, readonly MergeFieldKey[]> = {
  meeting_reminder: [...NAMES, "date", "time"],
  requested_document: [...NAMES, "document", "quoteLink", "validUntil"],
  collection: [...NAMES, "document", "amount", "dueDate"],
  verification_code: ["businessName", "verificationCode"],
};

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
  // a top-level label glued to Hebrew or Arabic letters ("evil.comשלום") is its ASCII part
  labels[n - 1] = labels[n - 1].replace(/^([a-z]{2,63})[א-תء-ي]+$/, "$1");
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
 * = app.message_token_link: an email address (exactly local@domain, a Hebrew/Arabic prefix with a hyphen and "." "-" at
 * both ends cut off) is a link when its local part is itself a host; else allowed when it is the business's plain email
 * (already through plainBusinessEmail()) or its domain is the business's own (owner (111) ב); any other token: each
 * "@"-free part.
 */
function tokenLink(token: string, own: string, businessEmail: string | null): boolean {
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
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?@[^@]+$/.test(value)) return null;
  const [local, domain] = value.split("@");
  if (domainSuffix(domain) !== domain || value.includes("..") || localPartHost(local) || domainSuffix(local) !== null) return null;
  return value;
}

/** True when the text holds a link that is not the business's own domain or its own email (= app.message_external_link). */
export function messageExternalLink(text: string, ownDomain: string | null = null, businessEmail: string | null = null): boolean {
  const value = text.normalize("NFKC").replace(INVISIBLE, "").replace(WIDE_DOTS, ".");
  const own = (ownDomain ?? "").trim().toLowerCase();
  const email = plainBusinessEmail(businessEmail);
  // the scheme scan comes first and knows nothing of the business email ("https://info@gmail.com" stays a link)
  for (const match of value.matchAll(AUTHORITY)) if (authorityLink(match[1], own)) return true;
  for (const match of value.matchAll(TOKEN)) if (tokenLink(match[0], own, email)) return true;
  return false;
}

function isService(type: MessageType): type is ServiceMessageType {
  return (SERVICE_MESSAGE_TYPES as readonly string[]).includes(type);
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
};

/** The business's own addresses a service message may hold (owners (105), (111)): its website's domain and its email. */
export type OwnAddresses = { ownDomain: string | null; businessEmail: string | null };

/** Every {field} of the template that its service type may not hold, in order, each once; [] for marketing. */
export function fieldsNotAllowed(template: TemplateText): string[] {
  if (!isService(template.messageType)) return [];
  const allowed = new Set(SERVICE_TYPE_FIELDS[template.messageType].map(fieldName));
  const found = new Set<string>();
  for (const match of `${template.subject ?? ""}\n${template.body}`.matchAll(MERGE_FIELD_PATTERN)) {
    if (!allowed.has(match[1])) found.add(match[0]);
  }
  return [...found];
}

/** null when the template may be sent; else the first problem, in the database's order. Marketing is never judged here. */
export function messageTemplateProblem(template: TemplateText): TemplateProblem | null {
  if (!isService(template.messageType)) return null;
  if (fieldsNotAllowed(template).length > 0) return "field_not_allowed";
  if (messageExternalLink(`${template.subject ?? ""}\n${template.body}`, template.ownDomain ?? null, template.businessEmail ?? null)) {
    return "external_link";
  }
  if ([...template.body].length > SERVICE_BODY_MAX[template.channel]) return "too_long";
  return null;
}

/** Why the template will not be sent, in Hebrew, for the settings page and the editor; null when it may be sent. */
export function templateProblemText(template: TemplateText): string | null {
  const problem = messageTemplateProblem(template);
  if (!problem || !isService(template.messageType)) return null;
  if (problem === "field_not_allowed") {
    const allowed = SERVICE_TYPE_FIELDS[template.messageType].map((key) => MESSAGE_MERGE_FIELDS[key].token).join(" ");
    return `התבנית לא תישלח: בהודעת שירות מהסוג הזה אפשר להשתמש רק בשדות ${allowed}. צריך להוריד את ${fieldsNotAllowed(template).join(", ")}.`;
  }
  if (problem === "external_link") {
    // owner (111) ב: an email address is allowed only on the business's own domain, or the business's own email
    const email = template.businessEmail?.trim() ? `, ואימייל רק בדומיין הזה או האימייל של העסק (${template.businessEmail.trim()})` : ", ואימייל רק בדומיין הזה";
    return ownDomainOk(template.ownDomain)
      ? `התבנית לא תישלח: בהודעת שירות אפשר לכתוב רק כתובות של האתר של העסק (${template.ownDomain})${email}. המערכת מוסיפה את הקישורים שלה דרך השדות, למשל {קישור להצעה}.`
      : `התבנית לא תישלח: בהודעת שירות אי אפשר לכתוב קישור, כתובת אתר או אימייל${template.businessEmail?.trim() ? ` מלבד האימייל של העסק (${template.businessEmail.trim()})` : ""}. המערכת מוסיפה את הקישורים שלה דרך השדות, למשל {קישור להצעה}. כתובת האתר של העסק מותרת אחרי שממלאים אותה בפרטי העסק.`;
  }
  const max = SERVICE_BODY_MAX[template.channel];
  return `התבנית לא תישלח: הודעת שירות בערוץ הזה יכולה להיות עד ${max.toLocaleString("he-IL")} תווים, והנוסח ארוך יותר (${[...template.body].length.toLocaleString("he-IL")}).`;
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
  external_link: "קישור חיצוני",
  inactive: "התבנית כבויה",
};
