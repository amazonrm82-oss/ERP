import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MESSAGE_MERGE_FIELDS, unknownMergeFields } from "@/features/message-templates/fields";
import { JUDGED_TYPE_FIELDS, messageTemplateProblem, SERVICE_BODY_MAX } from "@/features/message-templates/service-rule";
import { DEFAULT_REVIEW_REQUEST_TEMPLATES, isSystemOnlyType, MESSAGE_TYPE_LABELS, REVIEW_REQUEST_WORDING_VERSION } from "@/features/message-templates/templates";
import { MESSAGE_TYPES, messagePurpose, SERVICE_MESSAGE_TYPES } from "@/features/messaging/providers/types";
import { PLAN_CAPABILITIES } from "@/features/plans/capabilities";
import { normalizeReviewUrl, REVIEW_REQUEST_GAP_DAYS, reviewRequestSettingsSchema, reviewUrlOk } from "@/features/review-requests/review-url";
import { dbErrorMessage } from "@/lib/errors";
import { PLAN_VALUES } from "@/lib/plan-keys";

import cases from "./fixtures/review-urls.json";

const dir = join(__dirname, "..", "..", "supabase", "migrations");
const migration = (() => {
  const file = readdirSync(dir).find((f) => f.endsWith("_review_requests.sql"));
  if (!file) throw new Error("review_requests migration missing");
  return readFileSync(join(dir, file), "utf8");
})();

describe("RET-02: review requests", () => {
  it.each(cases.map((c) => [c.note, c]))("the link rule: %s", (_note, c) => {
    expect(reviewUrlOk(c.url)).toBe(c.ok);
  });

  it("the database's rule holds the same shapes and the same 90 days", () => {
    for (const host of ["'g.page'", "'search.google.com'", "'www.google.co.il'", "'maps.app.goo.gl'", "'g.co'"]) expect(migration).toContain(host);
    expect(migration).toContain("x.port in ('', ':443')");
    expect(migration).toContain("!~* '(^|&)(q|url|continue|adurl|pcurl|redirect|dest|next)='");
    expect(migration).toContain("position('%' in x.path) = 0");
    expect(migration).toContain("x.path !~ '(^|/)[.]{1,2}(/|$)'");
    expect(migration).toContain(`select ${REVIEW_REQUEST_GAP_DAYS} $$`);
  });

  it("is a marketing type, offered to nobody, with its own closed field list", () => {
    expect(MESSAGE_TYPES).toContain("review_request");
    expect(SERVICE_MESSAGE_TYPES as readonly string[]).not.toContain("review_request");
    expect(messagePurpose("review_request")).toBe("marketing");
    expect(MESSAGE_TYPE_LABELS.review_request).toBe("בקשת ביקורת");
    expect(isSystemOnlyType("review_request")).toBe(true);
    expect(isSystemOnlyType("marketing")).toBe(false);
    const fields = migration.match(/when 'review_request' then array\[([^\]]*)\]/);
    expect([...(fields?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual(
      JUDGED_TYPE_FIELDS.review_request.map((key) => MESSAGE_MERGE_FIELDS[key].token.slice(1, -1)),
    );
    expect(MESSAGE_MERGE_FIELDS.reviewLink.token).toBe("{קישור לביקורת}");
  });

  it("the DRAFT templates equal their seed and pass the rule", () => {
    expect(migration).toContain(`select '${REVIEW_REQUEST_WORDING_VERSION}' $$`);
    for (const d of DEFAULT_REVIEW_REQUEST_TEMPLATES) {
      expect(migration, d.name).toContain(`'${d.name}', '${d.channel}', ${d.subject === null ? "null::text" : `'${d.subject}'`},`);
      expect(migration, d.name).toContain(`'${d.body}'`);
      expect(unknownMergeFields(`${d.subject ?? ""} ${d.body}`), d.name).toEqual([]);
      expect(messageTemplateProblem({ channel: d.channel, messageType: d.messageType, subject: d.subject, body: d.body, noticeKind: d.noticeKind }), d.name).toBeNull();
      if (d.channel === "sms") expect([...d.body].length).toBeLessThanOrEqual(SERVICE_BODY_MAX.sms);
      // the review link comes only through its field
      expect(d.body).toContain("{קישור לביקורת}");
    }
  });

  it("no filter by satisfaction: the job reads no rating, score or outcome", () => {
    const job = migration.slice(migration.indexOf("create or replace function app.send_review_requests"));
    for (const word of ["rating", "score", "satisf", "outcome =", "nps"]) expect(job.toLowerCase(), word).not.toContain(word);
  });

  it("the plan key: basic and up, marked built", () => {
    expect([PLAN_VALUES.personal, PLAN_VALUES.basic, PLAN_VALUES.pro, PLAN_VALUES.business].map((p) => p.features.review_requests)).toEqual([false, true, true, true]);
    expect(PLAN_CAPABILITIES.find((c) => c.feature === "review_requests")?.built).toBe(true);
  });

  it("the settings form: a Google link is needed to switch on, and the errors are Hebrew", () => {
    expect(normalizeReviewUrl("g.page/r/abc/review")).toEqual({ ok: true, url: "https://g.page/r/abc/review" });
    expect(normalizeReviewUrl("https://example.com").ok).toBe(false);
    const on = reviewRequestSettingsSchema.safeParse({ enabled: "on", review_url: "", on_deal_won: "on", delay_days: "1" });
    expect(on.success).toBe(false);
    const none = reviewRequestSettingsSchema.safeParse({ enabled: "on", review_url: "https://g.page/r/abc/review", delay_days: "1" });
    expect(none.success).toBe(false);
    const good = reviewRequestSettingsSchema.safeParse({ enabled: "on", review_url: "https://g.page/r/abc/review", on_meeting_held: "on", delay_days: "0" });
    expect(good.success && good.data).toEqual({ enabled: true, review_url: "https://g.page/r/abc/review", on_deal_won: false, on_meeting_held: true, delay_days: 0 });
    expect(reviewRequestSettingsSchema.safeParse({ review_url: "", delay_days: "31" }).success).toBe(false);
    for (const hint of ["review_request:url", "review_request:incomplete", "feature:review_requests"]) {
      expect(dbErrorMessage({ code: "P0001", message: "x", hint }), hint).not.toBe(dbErrorMessage({ code: "P0001", message: "x", hint: "nothing:here" }));
    }
  });
});
