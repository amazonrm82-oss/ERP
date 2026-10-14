// CON-09: a new contact joins its company by the email domain.
// The rules live in the database (migration company_by_email_domain); this file mirrors them so
// the contact page can skip the lookup for an address that can never match. Keep the two in step:
// tests/unit/company-domain.test.ts compares the list with the migration.

/** Free mail providers: a contact with one of these addresses is never linked by domain. */
export const PUBLIC_EMAIL_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com",
  "hotmail.com", "hotmail.co.uk", "hotmail.fr", "outlook.com", "live.com", "live.co.uk", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "mail.com", "gmx.com", "gmx.net", "gmx.de", "web.de",
  "proton.me", "protonmail.com", "pm.me", "tutanota.com", "fastmail.com", "zoho.com", "hey.com",
  "yandex.com", "yandex.ru", "mail.ru", "inbox.ru", "bk.ru", "list.ru",
  "qq.com", "163.com",
  "walla.co.il", "walla.com", "012.net.il", "013.net", "013net.net", "netvision.net.il",
  "bezeqint.net", "zahav.net.il", "inter.net.il", "barak.net.il", "smile.net.il",
  "017.net.il", "nana10.co.il",
  "hotmail.co.il", "yahoo.co.il", "outlook.co.il", "nana.co.il", "actcom.co.il",
  // website and mail hosts: a site or address under them is never a company's own domain
  "wixsite.com", "wix.com", "myshopify.com", "wordpress.com", "weebly.com", "github.io", "gitlab.io",
  "blogspot.com", "blogspot.co.il", "netlify.app", "vercel.app", "herokuapp.com", "squarespace.com",
  "webflow.io", "sites.google.com", "pages.dev", "web.app", "firebaseapp.com", "azurewebsites.net",
  "godaddysites.com", "business.site", "tumblr.com", "carrd.co", "linktr.ee",
];

/**
 * app.domain_suffix(): two-label suffixes under which a registered domain has three labels (the Israeli
 * second levels, owner's list, and a few common foreign ones). Every other registered domain is one label
 * plus the TLD.
 */
export const DOMAIN_SUFFIXES: readonly string[] = [
  "co.il", "org.il", "net.il", "ac.il", "gov.il", "muni.il", "k12.il", "idf.il",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "com.br", "co.za", "co.jp", "com.cn", "com.tr",
  "co.in", "com.mx", "com.sg", "co.kr", "com.hk", "com.ar", "com.tw", "co.th", "com.my", "com.ph", "co.id", "com.ua",
  "com.pl", "co.at", "or.at", "com.cy", "com.gr", "com.eg", "com.sa", "co.ae", "ac.za", "org.nz", "ac.nz", "ac.jp",
  "ne.jp", "or.jp", "org.br", "net.br", "com.co", "com.pe", "com.vn", "co.ke", "com.ng",
];

const PUBLIC = new Set(PUBLIC_EMAIL_DOMAINS);
const SUFFIXES = new Set(DOMAIN_SUFFIXES);

// app.domain_ok(): labels of letters, digits and inner hyphens, a letters-only top level
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// btrim(x, E' \t\r\n') in SQL: only these four, not every Unicode space as String.trim() would
function trimSpaces(value: string): string {
  return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

function domainOk(value: string | null | undefined): string | null {
  return value && value.length <= 253 && HOST.test(value) ? value : null;
}

/** app.email_domain(): "Dana@Acme.co.il" -> "acme.co.il"; null unless it is one address with a valid domain. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const match = /^[^@\s]+@([^@\s]+)$/.exec(trimSpaces(email.slice(0, 320)).toLowerCase());
  return match ? domainOk(match[1].replace(/\.+$/, "")) : null;
}

/** app.website_domain(): "https://www.Acme.co.il:443/about" -> "acme.co.il". */
export function websiteDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  let host = trimSpaces(website.slice(0, 2000)).toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^/?#]*@/, "");
  host = host.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  host = host.replace(/\.+$/, "").replace(/^www\./, "");
  return domainOk(host);
}

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC.has(domain);
}

/** app.registered_domain(): "sales.acme.co.il" -> "acme.co.il", "a.b.acme.com" -> "acme.com"; null for "co.il" or "com". */
export function registeredDomain(domain: string | null | undefined): string | null {
  const valid = domainOk(domain);
  if (!valid) return null;
  const labels = valid.split(".");
  const n = labels.length;
  if (n >= 3 && SUFFIXES.has(labels.slice(n - 2).join("."))) return labels.slice(n - 3).join(".");
  if (n === 2 && SUFFIXES.has(valid)) return null;
  return labels.slice(n - 2).join(".");
}

/**
 * app.domain_candidates(): the domains an address is matched by, most specific first, from the full
 * domain down to the registered one. Empty when any of them is public or there is no registered domain.
 */
export function domainCandidates(domain: string | null | undefined): string[] {
  const valid = domainOk(domain);
  const registered = registeredDomain(valid);
  if (!valid || !registered) return [];
  const labels = valid.split(".");
  const keep = registered.split(".").length;
  const levels: string[] = [];
  for (let i = 0; i <= labels.length - keep; i++) levels.push(labels.slice(i).join("."));
  return levels.some((level) => PUBLIC.has(level)) ? [] : levels;
}

/** The address's full domain when it can match a company at all, else null. */
export function companyMatchDomain(email: string | null | undefined): string | null {
  const domain = emailDomain(email);
  return domainCandidates(domain).length > 0 ? domain : null;
}

/**
 * app.company_own_domain(): the company's own domain for display, its website's, else its email's;
 * only a usable one. A company with one is never matched by its contacts' emails.
 */
export function companyOwnDomain(website: string | null | undefined, email: string | null | undefined): string | null {
  const site = websiteDomain(website);
  if (domainCandidates(site).length > 0) return site;
  const mail = emailDomain(email);
  return domainCandidates(mail).length > 0 ? mail : null;
}

/** CON-09: the contact card shows at most this many companies to choose from. */
export const MAX_DOMAIN_CHOICES = 6;

/**
 * The choice on the contact card from company_domain_matches() rows (one tier, at most 7): null for
 * fewer than two; otherwise up to MAX_DOMAIN_CHOICES companies, and more = true when the tier holds more.
 */
export function domainChoices<T>(rows: readonly T[]): { companies: T[]; more: boolean } | null {
  if (rows.length < 2) return null;
  return { companies: rows.slice(0, MAX_DOMAIN_CHOICES), more: rows.length > MAX_DOMAIN_CHOICES };
}
