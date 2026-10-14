import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  companyMatchDomain,
  companyOwnDomain,
  DOMAIN_SUFFIXES,
  domainCandidates,
  domainChoices,
  MAX_DOMAIN_CHOICES,
  emailDomain,
  isPublicEmailDomain,
  PUBLIC_EMAIL_DOMAINS,
  registeredDomain,
  websiteDomain,
} from "@/features/company-domain/domains";

import { CANDIDATE_CASES, EMAIL_CASES, REGISTERED_CASES, WEBSITE_CASES } from "./fixtures/company-domain-cases";

describe("company by email domain (CON-09)", () => {
  it.each(EMAIL_CASES)("email %j -> %j", (input, expected) => {
    expect(emailDomain(input)).toBe(expected);
  });

  it.each(WEBSITE_CASES)("website %j -> %j", (input, expected) => {
    expect(websiteDomain(input)).toBe(expected);
  });

  it.each(REGISTERED_CASES)("registered domain of %j -> %j", (input, expected) => {
    expect(registeredDomain(input)).toBe(expected);
  });

  it.each(CANDIDATE_CASES)("candidates of %j -> %j", (input, expected) => {
    expect(domainCandidates(input)).toEqual(expected);
  });

  it("never stops at a suffix: co.il, com, net, org and the Israeli second levels", () => {
    for (const suffix of ["co.il", "org.il", "net.il", "ac.il", "gov.il", "muni.il", "k12.il", "idf.il", "com", "net", "org"]) {
      expect(registeredDomain(suffix), suffix).toBeNull();
      expect(domainCandidates(`x.y.${suffix}`).includes(suffix), suffix).toBe(false);
    }
  });

  it("never matches a public mail provider", () => {
    expect(isPublicEmailDomain("gmail.com")).toBe(true);
    expect(isPublicEmailDomain("walla.co.il")).toBe(true);
    expect(companyMatchDomain("Dana@Gmail.com")).toBeNull();
    expect(companyMatchDomain("dana@bezeqint.net")).toBeNull();
    expect(companyMatchDomain("dana@acme.co.il")).toBe("acme.co.il");
    expect(companyMatchDomain(null)).toBeNull();
    expect(companyMatchDomain("shop@acme.wixsite.com")).toBeNull();
    expect(companyMatchDomain("dana@sales.acme.co.il")).toBe("sales.acme.co.il");
  });

  it("includes every domain on the owner's list (14 October 2026)", () => {
    const owners = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "walla.co.il", "walla.com", "icloud.com", "me.com",
      "proton.me", "protonmail.com", "012.net.il", "013.net", "netvision.net.il", "bezeqint.net", "zahav.net.il", "017.net.il", "nana10.co.il"];
    for (const domain of owners) expect(isPublicEmailDomain(domain), domain).toBe(true);
  });

  it("a company's own domain: the website's, else its email's, never a public one", () => {
    expect(companyOwnDomain("https://www.acme.co.il", "info@other.co.il")).toBe("acme.co.il");
    expect(companyOwnDomain(null, "info@acme.co.il")).toBe("acme.co.il");
    expect(companyOwnDomain("gmail.com", "boss@gmail.com")).toBeNull();
    expect(companyOwnDomain("not a site", "office@walla.co.il")).toBeNull();
    expect(companyOwnDomain(null, null)).toBeNull();
    expect(companyOwnDomain("https://acme.wixsite.com/shop", "info@acme.co.il")).toBe("acme.co.il");
  });

  it("the contact card offers at most 6 companies and says when there are more", () => {
    expect(domainChoices([1])).toBeNull();
    expect(domainChoices([1, 2])).toEqual({ companies: [1, 2], more: false });
    expect(domainChoices([1, 2, 3, 4, 5, 6])).toEqual({ companies: [1, 2, 3, 4, 5, 6], more: false });
    expect(domainChoices([1, 2, 3, 4, 5, 6, 7])).toEqual({ companies: [1, 2, 3, 4, 5, 6], more: true });
    expect(MAX_DOMAIN_CHOICES).toBe(6);
  });

  it("the list is lower case, valid and without repeats", () => {
    expect(new Set(PUBLIC_EMAIL_DOMAINS).size).toBe(PUBLIC_EMAIL_DOMAINS.length);
    for (const domain of PUBLIC_EMAIL_DOMAINS) expect(emailDomain(`x@${domain}`)).toBe(domain);
  });

  const sqlList = (marker: string) => {
    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/20261006018200_company_by_email_domain.sql"), "utf8");
    const block = sql.split(`-- ${marker}:start`)[1].split(`-- ${marker}:end`)[0];
    return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };

  it("the TS public list equals the one in the migration", () => {
    expect(sqlList("public-domains")).toEqual([...PUBLIC_EMAIL_DOMAINS]);
  });

  it("the TS suffix list equals the one in the migration", () => {
    expect(sqlList("domain-suffixes")).toEqual([...DOMAIN_SUFFIXES]);
    expect(new Set(DOMAIN_SUFFIXES).size).toBe(DOMAIN_SUFFIXES.length);
  });
});
