import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { instantReplyChannels, INSTANT_REPLY_MARKER } from "@/features/intake/instant-reply";
import { unknownMergeFields } from "@/features/message-templates/fields";
import { messageTemplateProblem, SERVICE_BODY_MAX, SERVICE_TYPE_FIELDS } from "@/features/message-templates/service-rule";
import { DEFAULT_INSTANT_REPLY_TEMPLATES, INSTANT_REPLY_WORDING_VERSION, isInstantReplyNoticeTemplate, MESSAGE_TYPE_LABELS } from "@/features/message-templates/templates";
import { dbErrorMessage, INSTANT_REPLY_DELETE, INSTANT_REPLY_LINK, INSTANT_REPLY_OFFER } from "@/lib/errors";
import { SERVICE_MESSAGE_TYPES } from "@/features/messaging/providers/types";
import { PLAN_CAPABILITIES } from "@/features/plans/capabilities";

const dir = join(__dirname, "..", "..", "supabase", "migrations");
const migration = (() => {
  const file = readdirSync(dir).find((f) => f.endsWith("_instant_reply.sql"));
  if (!file) throw new Error("instant_reply migration missing");
  return readFileSync(join(dir, file), "utf8");
})();

describe("SPD-04: the instant reply", () => {
  it("is a service type, sent whatever the window but not past the rates (review 2), and marked built", () => {
    expect(migration).toContain("create or replace function app.message_window_exempt(p_type text)");
    expect(migration).not.toContain("create or replace function app.message_always_sends");
    expect(migration).toContain("if not app.message_window_exempt(v_type) then");
    expect(migration).toContain("when 'hours' then not app.message_window_exempt(j.payload ->> 'message_type')");
    expect(SERVICE_MESSAGE_TYPES).toContain("instant_reply");
    expect(MESSAGE_TYPE_LABELS.instant_reply).toBeTruthy();
    expect(migration).toContain("p_type in ('verification_code', 'instant_reply')");
    expect(PLAN_CAPABILITIES.find((c) => c.feature === "instant_reply")?.built).toBe(true);
  });

  it("the four DRAFT templates equal their seed and pass the service rule with their type's fields only", () => {
    expect(migration).toContain(`'${INSTANT_REPLY_WORDING_VERSION}'`);
    expect(DEFAULT_INSTANT_REPLY_TEMPLATES).toHaveLength(4);
    for (const d of DEFAULT_INSTANT_REPLY_TEMPLATES) {
      expect(migration, d.name).toContain(`'${d.name}', '${d.channel}', ${d.subject === null ? "null::text" : `'${d.subject}'`}, '${d.noticeKind}',`);
      expect(migration, d.name).toContain(`'${d.body}'`);
      expect(unknownMergeFields(`${d.subject ?? ""} ${d.body}`), d.name).toEqual([]);
      expect(messageTemplateProblem({ channel: d.channel, messageType: d.messageType, subject: d.subject, body: d.body, noticeKind: d.noticeKind }), d.name).toBeNull();
      if (d.channel === "sms") expect([...d.body].length).toBeLessThanOrEqual(SERVICE_BODY_MAX.sms);
    }
    // owner (80) א: no link, no offer; the return time and the business sign it
    expect(SERVICE_TYPE_FIELDS.instant_reply).toEqual(["firstName", "businessName", "businessPhone", "time"]);
    // (261) א: outside working hours "ביום העבודה הבא עד {שעה}"
    expect(DEFAULT_INSTANT_REPLY_TEMPLATES.filter((d) => d.noticeKind === "instant_reply_closed").every((d) => d.body.includes("ביום העבודה הבא עד {שעה}"))).toBe(true);
    // owner (282) ב: the marked templates are kept (never deleted) and editable; an offer or a link is refused, in Hebrew
    for (const d of DEFAULT_INSTANT_REPLY_TEMPLATES) expect(isInstantReplyNoticeTemplate(d.noticeKind)).toBe(true);
    expect(isInstantReplyNoticeTemplate("signature_reminder")).toBe(false);
    expect(isInstantReplyNoticeTemplate(null)).toBe(false);
    expect(dbErrorMessage({ code: "P0001", message: "x", hint: "message_template:instant_reply_delete" })).toBe(INSTANT_REPLY_DELETE);
    expect(dbErrorMessage({ code: "P0001", message: "x", hint: "message_template:offer" })).toBe(INSTANT_REPLY_OFFER);
    expect(dbErrorMessage({ code: "P0001", message: "x", hint: "message_template:instant_reply_link" })).toBe(INSTANT_REPLY_LINK);
    expect(messageTemplateProblem({ channel: "sms", messageType: "instant_reply", subject: null, body: "ראו www.example.com" })).toBe("external_link");
  });

  it("chooses SMS when the business has SMS and the typed phone is the record's, else email", () => {
    expect(instantReplyChannels({ typedPhoneMatches: true, typedEmailMatches: true, sms: true })).toEqual(["sms", "email"]);
    expect(instantReplyChannels({ typedPhoneMatches: true, typedEmailMatches: true, sms: false })).toEqual(["email"]);
    expect(instantReplyChannels({ typedPhoneMatches: true, typedEmailMatches: false, sms: false })).toEqual([]);
    expect(instantReplyChannels({ typedPhoneMatches: false, typedEmailMatches: false, sms: true })).toEqual([]);
    // the database's order is the same (app.instant_reply_queue)
    expect(migration.indexOf("v_channels := v_channels || 'sms'::text")).toBeLessThan(migration.indexOf("v_channels := v_channels || 'email'::text"));
  });

  it("intake_submit is untouched; the reply hangs off emit_form_submitted in its own exception block", () => {
    expect(migration).not.toContain("function public.intake_submit");
    expect(migration).toMatch(/perform app\.instant_reply_queue\([^)]*\);\n  exception when others then/);
    expect(INSTANT_REPLY_MARKER).toBe("instant_reply_shown");
  });
});
