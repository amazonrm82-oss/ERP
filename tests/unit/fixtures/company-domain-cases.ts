// CON-09: parsing cases shared by the TS mirror (tests/unit/company-domain.test.ts) and the SQL
// functions (tests/db/99-company-by-domain.test.ts), so the two cannot drift apart.

export const EMAIL_CASES: Array<[string, string | null]> = [
  ["dana@acme.co.il", "acme.co.il"],
  ["  Dana@ACME.co.IL ", "acme.co.il"],
  ["\tdana@acme.co.il\n", "acme.co.il"],
  ["\r\ndana@acme.co.il\t ", "acme.co.il"],
  ["dana@acme.co.il.", "acme.co.il"],
  ["dana@sales.acme.co.il", "sales.acme.co.il"],
  ["dana@my-shop.com", "my-shop.com"],
  ["dana", null],
  ["dana@", null],
  ["@acme.co.il", null],
  ["a@b@acme.co.il", null],
  ["dana@localhost", null],
  ["dana@-acme.com", null],
  ["dana@acme-.com", null],
  ["dana@127.0.0.1", null],
  ["dana@acme..com", null],
  ["dana @acme.com", null],
  ["דנה@אקמה.co.il", null],
  ["", null],
];

export const WEBSITE_CASES: Array<[string, string | null]> = [
  ["acme.co.il", "acme.co.il"],
  ["www.acme.co.il", "acme.co.il"],
  [" \thttps://acme.co.il\r\n", "acme.co.il"],
  ["https://www.Acme.co.il/about?x=1#top", "acme.co.il"],
  ["http://acme.co.il:8080", "acme.co.il"],
  ["HTTPS://ACME.CO.IL/", "acme.co.il"],
  ["https://user:pass@acme.co.il/x", "acme.co.il"],
  ["https://shop.acme.co.il", "shop.acme.co.il"],
  ["acme.co.il?ref=1", "acme.co.il"],
  ["https://www.acme.co.il.", "acme.co.il"],
  ["not a site", null],
  ["https://", null],
  ["localhost", null],
  ["", null],
];


// app.registered_domain() / registeredDomain()
export const REGISTERED_CASES: Array<[string, string | null]> = [
  ["acme.co.il", "acme.co.il"],
  ["sales.acme.co.il", "acme.co.il"],
  ["a.b.c.acme.com", "acme.com"],
  ["acme.com", "acme.com"],
  ["acme.il", "acme.il"],
  ["x.acme.k12.il", "acme.k12.il"],
  ["shop.acme.co.uk", "acme.co.uk"],
  ["shop.acme.com.mx", "acme.com.mx"],
  ["a.acme.or.at", "acme.or.at"],
  ["com.mx", null],
  ["co.il", null],
  ["com", null],
  ["k12.il", null],
  ["not a domain", null],
];

// app.domain_candidates() / domainCandidates(): most specific first, never beyond the registered domain
export const CANDIDATE_CASES: Array<[string, string[]]> = [
  ["acme.co.il", ["acme.co.il"]],
  ["sales.acme.co.il", ["sales.acme.co.il", "acme.co.il"]],
  ["a.b.c.acme.com", ["a.b.c.acme.com", "b.c.acme.com", "c.acme.com", "acme.com"]],
  ["co.il", []],
  ["gmail.com", []],
  ["x.wixsite.com", []],
  ["shop.myshopify.com", []],
  ["sites.google.com", []],
  ["mail.walla.co.il", []],
  ["google.com", ["google.com"]],
];
