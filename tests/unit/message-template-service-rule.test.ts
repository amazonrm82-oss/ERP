import { describe, expect, it } from "vitest";

import { MESSAGE_MERGE_FIELDS } from "@/features/message-templates/fields";
import {
  assertTemplateSendable,
  envelopedFilledProblem,
  FILE_EXTENSIONS,
  GLUE_BOUNDARY_RANGES,
  LINK_TLDS,
  asciiLower,
  plainBusinessEmail,
  MARKETING_BODY_MAX,
  messageAddressGlue,
  messageExternalLink,
  messageFilledProblem,
  ownDomainOk,
  PLATFORM_DOMAINS,
  SHARED_SITE_HOSTS,
  URL_SHORTENERS,
  websiteOk,
  messageTemplateProblem,
  SEND_REFUSAL_LABELS,
  SERVICE_BODY_MAX,
  SERVICE_TYPE_FIELDS,
  templateProblemText,
  TemplateNotSendableError,
  type TemplateText,
} from "@/features/message-templates/service-rule";
import { DEFAULT_MESSAGE_TEMPLATES, DEFAULT_PUNCH_CARD_TEMPLATES } from "@/features/message-templates/templates";
import { SERVICE_MESSAGE_TYPES } from "@/features/messaging/providers/types";

import filledCases from "./fixtures/message-filled-problems.json";
import cases from "./fixtures/message-template-problems.json";
import { latestMigration } from "./helpers/migrations";

const sql = latestMigration("create or replace function app.message_type_fields(")?.sql ?? "";
const sendSql = latestMigration("create or replace function app.message_filled_problem(")?.sql ?? "";
const tldSql = latestMigration("create or replace function app.message_link_tld(")?.sql ?? "";
const gluedSql = latestMigration("create or replace function app.message_glue_boundary(")?.sql ?? "";

describe("service template rule (MSG-02, owner (90) ג)", () => {
  it.each(cases.map((c) => [c.note, c]))("%s", (_note, c) => {
    expect(messageTemplateProblem(c as TemplateText)).toBe(c.problem);
  });

  it("the allowed fields per type equal app.message_type_fields", () => {
    expect(sql).not.toBe("");
    expect(Object.keys(SERVICE_TYPE_FIELDS).sort()).toEqual([...SERVICE_MESSAGE_TYPES].sort());
    for (const type of SERVICE_MESSAGE_TYPES) {
      const match = sql.match(new RegExp(`when '${type}' then array\\[([^\\]]*)\\]`));
      expect(match, type).not.toBeNull();
      const names = [...(match?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
      expect(names, type).toEqual(SERVICE_TYPE_FIELDS[type].map((key) => MESSAGE_MERGE_FIELDS[key].token.slice(1, -1)));
    }
  });

  it("the caps equal app.message_service_body_max", () => {
    const capsSql = latestMigration("create or replace function app.message_service_body_max(")?.sql ?? "";
    expect(capsSql).toContain(
      `case p_channel when 'sms' then ${SERVICE_BODY_MAX.sms} when 'whatsapp' then ${SERVICE_BODY_MAX.whatsapp} when 'email' then ${SERVICE_BODY_MAX.email} end`,
    );
  });

  it("every default service template may be sent", () => {
    for (const d of DEFAULT_MESSAGE_TEMPLATES) expect(messageTemplateProblem(d), d.name).toBeNull();
    // PKG-03: the punch card notices use only their type's fields, hold no link and fit one SMS cap
    for (const d of DEFAULT_PUNCH_CARD_TEMPLATES) expect(messageTemplateProblem(d), d.name).toBeNull();
  });

  it("says why in Hebrew, and the sender gate throws", () => {
    const base = { channel: "sms" as const, messageType: "collection" as const, subject: null };
    expect(templateProblemText({ ...base, body: "{תאריך}" })).toMatch(/^התבנית לא תישלח: .*\{תאריך\}/);
    expect(templateProblemText({ ...base, body: "www.x.com" })).toContain("קישור");
    expect(templateProblemText({ ...base, body: "א".repeat(301) })).toContain("300");
    expect(templateProblemText({ ...base, body: "שלום {שם פרטי}" })).toBeNull();
    expect(() => assertTemplateSendable({ ...base, body: "שלום", isActive: true })).not.toThrow();
    expect(() => assertTemplateSendable({ ...base, body: "שלום", isActive: false })).toThrow(TemplateNotSendableError);
    expect(() => assertTemplateSendable({ ...base, body: "https://x.com", isActive: true })).toThrow(/external_link/);
  });

  it.each(filledCases.map((c) => [c.note, c]))("filled text: %s", (_note, c) => {
    expect(messageFilledProblem(c as TemplateText)).toBe(c.problem);
  });

  it("the filled-text rule and the refusal helper live in the same migration as the link rule", () => {
    expect(sendSql).toContain("create or replace function app.message_send_refused(");
    expect(sendSql).toContain("create or replace function app.message_external_link(");
    // owner (96): the log says "ארוכה מדי"
    expect(SEND_REFUSAL_LABELS.too_long).toBe("ארוכה מדי");
    expect(sendSql).toContain("when 'too_long' then 'ארוכה מדי");
  });

  it("the closed lists and the marketing caps equal the migration's", () => {
    const list = (marker: string) => {
      const block = sendSql.split(`-- ${marker}:start`)[1]?.split(`-- ${marker}:end`)[0] ?? "";
      return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    };
    expect(list("shared-site-hosts")).toEqual([...SHARED_SITE_HOSTS]);
    expect(list("url-shorteners")).toEqual([...URL_SHORTENERS]);
    expect(list("file-extensions")).toEqual([...FILE_EXTENSIONS]);
    expect(list("platform-domains")).toEqual([...PLATFORM_DOMAINS]);
    expect(sendSql).toContain(
      `case p_channel when 'sms' then ${MARKETING_BODY_MAX.sms} when 'whatsapp' then ${MARKETING_BODY_MAX.whatsapp} when 'email' then ${MARKETING_BODY_MAX.email} end`,
    );
  });

  it("(102): a marketing message is counted with what the system adds", () => {
    const fill = (text: string) => text.replaceAll("{שם העסק}", "עסק").replaceAll("{טלפון העסק}", "03-0000000").replaceAll("{כתובת העסק}", "רחוב 1").replaceAll("{קישור הסרה}", "https://x.example/u/abc");
    const marketing = { channel: "sms" as const, messageType: "marketing" as const, subject: null };
    // 560 characters fit the cap alone, but not with the prefix and the two lines
    expect(messageFilledProblem({ ...marketing, body: "א".repeat(560) })).toBeNull();
    expect(envelopedFilledProblem({ ...marketing, body: "א".repeat(560) }, fill)).toBe("too_long");
    expect(envelopedFilledProblem({ ...marketing, body: "שלום" }, fill)).toBeNull();
    // a service message is not enveloped
    expect(envelopedFilledProblem({ channel: "sms", messageType: "collection", subject: null, body: "א".repeat(300) }, fill)).toBeNull();
  });

  it("(104) review 3: only a domain that can be the business's own", () => {
    expect(ownDomainOk("biz.co.il")).toBe(true);
    expect(ownDomainOk("mybiz.wixsite.com")).toBe(true);
    for (const bad of ["co.il", "com", "bit.ly", "wixsite.com", "gmail.com", "sites.google.com", "x.bit.ly", "facebook.com", "business.facebook.com", "amazonaws.com", null])
      expect(ownDomainOk(bad), String(bad)).toBe(false);
  });

  it("review 2, item 4: a website is http(s) or a bare host", () => {
    for (const good of ["biz.co.il", "http://biz.co.il", "HTTPS://www.Biz.co.il/about", " biz.co.il "]) expect(websiteOk(good), good).toBe(true);
    for (const bad of ["javascript:alert(1)", "ftp://biz.co.il", "data:text/html,x", "mailto:a@biz.co.il", "biz.co.il:8080", "facebook.com/mybiz", "x".repeat(301)])
      expect(websiteOk(bad), bad).toBe(false);
  });

  it("the own domain is allowed only with its subdomains, and the text says so", () => {
    expect(messageExternalLink("biz.co.il", "biz.co.il")).toBe(false);
    expect(messageExternalLink("biz.co.il", null)).toBe(true);
    const base = { channel: "sms" as const, messageType: "collection" as const, subject: null };
    expect(templateProblemText({ ...base, body: "other.com", ownDomain: "biz.co.il" })).toContain("biz.co.il");
    expect(templateProblemText({ ...base, body: "other.com" })).toContain("פרטי העסק");
  });

  it("owner (110) ב: the endings equal app.message_link_tld, each once, letters only, and none names a file", () => {
    const block = tldSql.split("-- link-tlds:start")[1]?.split("-- link-tlds:end")[0] ?? "";
    expect([...block.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...LINK_TLDS]);
    expect(new Set(LINK_TLDS).size).toBe(LINK_TLDS.length);
    for (const tld of LINK_TLDS) {
      expect(tld, tld).toMatch(/^[a-z]{2,63}$/);
      expect(FILE_EXTENSIONS, tld).not.toContain(tld);
    }
    // the redefinitions of this migration build on 021160's bodies
    expect(tldSql).toContain("create or replace function app.message_domain_suffix(");
    expect(tldSql).toContain("create or replace function app.message_external_link(p_text text, p_own_domain text, p_business_email text)");
  });

  it("owner (111) ב: only a plain business email counts, ASCII letters folded only", () => {
    expect(asciiLower("ABC אב İ")).toBe("abc אב İ");
    expect(plainBusinessEmail(" Biz.Office@Gmail.COM ")).toBe("biz.office@gmail.com");
    for (const bad of ["https://evil.com/x@y.co", "www.evil.com/x@y.co", "evil.com@y.co", "www.x@y.co", "a_b@y.co", "a+b@y.co", ".a@y.co", "a@localhost", "evil.com.x@gmail.com", "evil..com@gmail.com", "evil.com-x@gmail.com", "1.2.3.4@gmail.com", "", null])
      expect(plainBusinessEmail(bad), String(bad)).toBeNull();
    expect(messageExternalLink("info@biz.co.il", "biz.co.il", null)).toBe(false);
    expect(plainBusinessEmail("dana.cohen@gmail.com")).toBe("dana.cohen@gmail.com");
    expect(messageExternalLink("info@gmail.com", null, "info@gmail.com")).toBe(false);
    expect(messageExternalLink("https://info@gmail.com", null, "info@gmail.com")).toBe(true);
    expect(messageExternalLink("info@gmail.com", null, null)).toBe(true);
  });

  it("owner (113) א: the glue boundaries equal app.message_glue_boundary, and the code has its texts", () => {
    const block = gluedSql.split("-- glue-boundaries:start")[1]?.split("-- glue-boundaries:end")[0] ?? "";
    const numbers = [...block.replace(/--[^\n]*/g, "").matchAll(/\d+/g)].map((m) => Number(m[0]));
    expect(numbers).toEqual(GLUE_BOUNDARY_RANGES.flat());
    for (const [from, to] of GLUE_BOUNDARY_RANGES) expect(from <= to && from > 127, `${from}-${to}`).toBe(true);
    expect(gluedSql).toContain("when 'glued_address' then 'יש בתבנית כתובת צמודה לטקסט'");
    expect(SEND_REFUSAL_LABELS.glued_address).toBe("כתובת צמודה לטקסט");
    const base = { channel: "sms" as const, messageType: "collection" as const, subject: null, businessEmail: "info@gmail.com" };
    expect(templateProblemText({ ...base, body: "שלוםinfo@gmail.com" })).toContain("הכתובת צמודה לטקסט");
    expect(templateProblemText({ ...base, body: "שלום info@gmail.com" })).toBeNull();
    expect(messageAddressGlue("dana_info@gmail.com", null, "info@gmail.com")).toBe("external_link");
    expect(messageAddressGlue("info@gmail.com", null, "info@gmail.com")).toBeNull();
    expect(messageAddressGlue("moreinfo@biz.co.il", "biz.co.il", "info@biz.co.il")).toBeNull();
  });

  it("the glue rule is linear on long hostile text", () => {
    const hostile = [
      "a@b.co".repeat(30_000),
      "שa@b.co ".repeat(25_000),
      "ж".repeat(100_000) + "a@b.co",
      "a@".repeat(100_000),
      "@".repeat(200_000),
      "a.".repeat(100_000) + "@b.co",
      "_a@b.co".repeat(30_000),
      "{x}a@b.co".repeat(20_000),
      "🙂a@b.co".repeat(25_000),
      "ж.com".repeat(40_000),
      "a@evil.com-x".repeat(15_000),
      "a@b.co-שלום ".repeat(15_000),
      "-ש".repeat(100_000),
    ];
    for (const text of hostile) {
      const started = performance.now();
      messageAddressGlue(text, "biz.co.il", "a@b.co");
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it("the link rule is linear on long hostile text", () => {
    const hostile = [
      "a.".repeat(100_000) + "1",
      "-".repeat(200_000) + "x",
      "http://".repeat(30_000),
      "https://a:".repeat(20_000),
      "www.".repeat(50_000),
      "a@".repeat(100_000),
      "a".repeat(200_000) + ".com",
      "1.".repeat(100_000),
      "א.".repeat(100_000) + "com",
    ];
    hostile.push("a@b.co".repeat(30_000), "(a@b.co)".repeat(30_000), "a@b.co.".repeat(30_000), "ל-a@b.co".repeat(30_000));
    for (const text of hostile) {
      const started = performance.now();
      messageExternalLink(text, "biz.co.il", "a@b.co");
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});
