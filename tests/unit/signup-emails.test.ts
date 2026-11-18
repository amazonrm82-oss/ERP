import { describe, expect, it } from "vitest";

import type { OutgoingMessage } from "@/features/messaging/providers/types";
import { buildSignupEmail, NEUTRAL_BUSINESS_NAME, SIGNUP_EMAIL_WORDING, trialEndLabel } from "@/features/signup-emails/email";
import { createSignupHandler, parseSignupComposed } from "@/features/signup-emails/send-handler";

// WEB-05 (owner (418) ב): the two service emails to a new sign-up and the signup.send handler.

describe("the fixed texts", () => {
  const link = "https://mexuzsystem.com/o/11111111-2222-4333-8444-555555555555";

  it("a welcome names the business, the trial's last day and the link; a DRAFT with a version", () => {
    const mail = buildSignupEmail({ kind: "welcome", businessName: "סטודיו‮ דנה", trialEndDay: "2026-12-02", link })!;
    expect(SIGNUP_EMAIL_WORDING).toBe("signup-draft-1");
    expect(mail.subject).toBe("ברוכים הבאים למקסוז, סטודיו דנה");
    expect(mail.text).toBe(
      [
        "שלום,",
        "החשבון של סטודיו דנה במקסוז נפתח.",
        "תקופת הניסיון פעילה עד 2 בדצמבר 2026.",
        "",
        `לכניסה לעסק: ${link}`,
        "",
        "—",
        "המייל נשלח ממקסוז אל בעלי החשבון. זו הודעת שירות על החשבון שלך. אין להשיב למייל הזה.",
      ].join("\n"),
    );
    expect(mail.links).toEqual([link]);
  });

  it("trial ending says the day and points to the plan screen; nothing without a valid day", () => {
    const mail = buildSignupEmail({ kind: "trial_ending", businessName: "עסק", trialEndDay: "2026-11-21", link })!;
    expect(mail.subject).toBe("תקופת הניסיון של עסק במקסוז מסתיימת בקרוב");
    expect(mail.text).toContain("תקופת הניסיון של עסק במקסוז מסתיימת ב-21 בנובמבר 2026.");
    expect(mail.text).toContain(link);
    expect(buildSignupEmail({ kind: "trial_ending", businessName: "עסק", trialEndDay: null, link })).toBeNull();
    expect(buildSignupEmail({ kind: "trial_ending", businessName: "עסק", trialEndDay: "2026-02-30", link })).toBeNull();
  });

  it("no offer, tip or price in either text (service only, owner (418) ב)", () => {
    for (const kind of ["welcome", "trial_ending"] as const) {
      const mail = buildSignupEmail({ kind, businessName: "עסק", trialEndDay: "2026-11-21", link })!;
      expect(mail.text).not.toMatch(/הנחה|מבצע|טיפ|₪|%|חינם|הטבה/);
    }
  });

  it("with the neutral name the texts name no business", () => {
    const welcome = buildSignupEmail({ kind: "welcome", businessName: NEUTRAL_BUSINESS_NAME, trialEndDay: null, link })!;
    expect(welcome.subject).toBe("ברוכים הבאים למקסוז");
    expect(welcome.text).toContain("החשבון של העסק במקסוז נפתח.");
    expect(welcome.text).not.toContain("תקופת הניסיון");
    const ending = buildSignupEmail({ kind: "trial_ending", businessName: "", trialEndDay: "2026-11-21", link })!;
    expect(ending.subject).toBe("תקופת הניסיון במקסוז מסתיימת בקרוב");
  });

  it("reads only real days", () => {
    expect(trialEndLabel("2026-11-21")).toBe("21 בנובמבר 2026");
    expect(trialEndLabel("21/11/2026")).toBeNull();
    expect(trialEndLabel(null)).toBeNull();
  });
});

describe("the signup.send handler", () => {
  const org = "11111111-2222-4333-8444-555555555555";
  const user = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const job = { id: "j1", lease: "l", kind: "signup.send" as const, organization_id: org, payload: { organization_id: org, user_id: user, kind: "trial_ending" }, attempt: 1 };
  const answer = { to: "owner@example.com", business_name: "עסק", kind: "trial_ending", trial_end_day: "2026-11-21" };

  it("parses only the composer's own shape", () => {
    expect(parseSignupComposed(answer)).toEqual({ ok: true, to: "owner@example.com", businessName: "עסק", kind: "trial_ending", trialEndDay: "2026-11-21" });
    expect(parseSignupComposed({ ...answer, trial_end_day: null })).toMatchObject({ ok: true, trialEndDay: null });
    expect(parseSignupComposed({ ...answer, kind: "tips" })).toBeNull();
    expect(parseSignupComposed({ ...answer, trial_end_day: "tomorrow" })).toBeNull();
    expect(parseSignupComposed({ refused: "not_trialing" })).toEqual({ ok: false, code: "not_trialing" });
    expect(parseSignupComposed({ refused: "Not a code" })).toBeNull();
    expect(parseSignupComposed(null)).toBeNull();
  });

  it("sends the fixed text with no reply-to or unsubscribe header; a refusal sends nothing", async () => {
    const sent: OutgoingMessage[] = [];
    const provider = { name: "fake", channel: "email" as const, send: async (m: OutgoingMessage) => (sent.push(m), { ok: true as const, providerId: "p1" }) };
    const done = await createSignupHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => answer })(job);
    expect(done).toEqual({ status: "done", receipt: { provider: "fake", providerMessageId: "p1" } });
    expect(sent[0]).toMatchObject({ channel: "email", purpose: "service", messageType: null, recordType: "user", recordId: user });
    const mail = sent[0].emailContent!;
    expect(mail.to).toBe("owner@example.com");
    expect(mail.replyTo).toBeNull();
    expect(mail.listUnsubscribe).toBeNull();
    expect(mail.links).toEqual([`https://mexuzsystem.com/o/${org}/settings/plan`]);
    const welcome = await createSignupHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => ({ ...answer, kind: "welcome" }) })(job);
    expect(welcome).toMatchObject({ status: "done" });
    expect(sent[1].emailContent!.links).toEqual([`https://mexuzsystem.com/o/${org}`]);

    for (const code of ["not_trialing", "trial_over", "not_owner", "business_closed"]) {
      const refused = await createSignupHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => ({ refused: code }) })(job);
      expect(refused).toMatchObject({ status: "failed", final: true, receipt: { provider: null, errorCode: code } });
    }
    const stale = await createSignupHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => ({ refused: "stale" }) })(job);
    expect(stale).toEqual({ status: "failed", error: "stale lease" });
    const noSite = await createSignupHandler({ provider, siteOrigin: () => "", compose: async () => answer })(job);
    expect(noSite).toEqual({ status: "failed", error: "site url missing" });
    expect(sent).toHaveLength(2);
  });

  it("a provider failure is reported with its code, never the address", async () => {
    const provider = { name: "fake", channel: "email" as const, send: async () => ({ ok: false as const, error: "boom", code: "x", final: true }) };
    const failed = await createSignupHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => answer })(job);
    expect(failed).toEqual({ status: "failed", error: "boom", final: true, receipt: { provider: "fake", errorCode: "x" } });
    expect(JSON.stringify(failed)).not.toContain("owner@example.com");
  });
});
