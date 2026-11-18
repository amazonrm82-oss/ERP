import { describe, expect, it } from "vitest";

import type { OutgoingMessage } from "@/features/messaging/providers/types";
import {
  buildSignupEmail,
  greetingName,
  NEUTRAL_BUSINESS_NAME,
  SIGNUP_EMAIL_WORDING,
  trialEndLabel,
  trialEndWeekdayLabel,
} from "@/features/signup-emails/email";
import { createSignupHandler, parseSignupComposed } from "@/features/signup-emails/send-handler";
import { SUPPORT_PHONE } from "@/lib/support-phone";

// WEB-05 (owner (418) ב): the two service emails to a new sign-up and the signup.send handler.

describe("the fixed texts (owner (443) ב, signup-draft-2)", () => {
  const base = "https://mexuzsystem.com/o/11111111-2222-4333-8444-555555555555";
  const links = {
    business: base,
    plan: `${base}/settings/plan`,
    users: `${base}/settings/users`,
    intake: `${base}/settings/intake`,
    imports: `${base}/settings/import`,
  };
  const footer = (of: string) =>
    `המייל נשלח לבעלי החשבון של ${of} במקסוז. זו הודעת שירות על החשבון, לא פרסומת. לשאלות אפשר לפנות אלינו: ${SUPPORT_PHONE} (גם ב-WhatsApp).`;

  it("a welcome greets by first name, lists the three first steps with links, the trial line while given, the business link", () => {
    const mail = buildSignupEmail({ kind: "welcome", firstName: "דנה", businessName: "סטודיו\u202e דנה", trialEndDay: "2026-12-02", links })!;
    expect(SIGNUP_EMAIL_WORDING).toBe("signup-draft-2");
    expect(mail.subject).toBe("ברוכים הבאים למקסוז, סטודיו דנה");
    expect(mail.text).toBe(
      [
        "שלום דנה,",
        "החשבון של סטודיו דנה במקסוז נפתח.",
        "",
        "כמה דברים שכדאי לעשות עכשיו:",
        `להוסיף את העובדים: ${links.users}`,
        `לחבר טופס פניות לאתר: ${links.intake}`,
        `לייבא לקוחות מאקסל: ${links.imports}`,
        "",
        "תקופת הניסיון פעילה עד 2 בדצמבר 2026.",
        "",
        `לכניסה לעסק: ${base}`,
        "",
        "—",
        footer("סטודיו דנה"),
      ].join("\n"),
    );
    expect(mail.links).toEqual([links.users, links.intake, links.imports, base]);
    expect(mail.text).not.toContain("אין להשיב");
  });

  it("owner (444) א: a welcome without a trial end day (switch off, or no trial at all) has no trial line", () => {
    const mail = buildSignupEmail({ kind: "welcome", firstName: null, businessName: "עסק", trialEndDay: null, links })!;
    expect(mail.text).not.toContain("תקופת הניסיון");
    expect(mail.text.split("\n").slice(0, 2)).toEqual(["שלום,", "החשבון של עסק במקסוז נפתח."]);
    expect(mail.text).toContain(`\n\nלכניסה לעסק: ${base}`);
    expect(mail.text).toContain("כמה דברים שכדאי לעשות עכשיו:");
  });

  it("no name, or a name that is not a plain name, opens with \"שלום,\"", () => {
    for (const firstName of [null, "", "   ", "a@b.co", "https://x.co", "www.spam.example", "דנה\u202e", "א".repeat(41)]) {
      const mail = buildSignupEmail({ kind: "welcome", firstName, businessName: "עסק", trialEndDay: null, links })!;
      expect(mail.text.split("\n")[0]).toBe("שלום,");
    }
    expect(greetingName("  משה כהן ")).toBe("משה");
    expect(greetingName("א".repeat(40))).toBe("א".repeat(40));
  });

  it("trial ending names the weekday and the day and points to the plan screen; nothing without a valid day", () => {
    const mail = buildSignupEmail({ kind: "trial_ending", firstName: "יוסי", businessName: "עסק", trialEndDay: "2026-11-20", links })!;
    expect(mail.subject).toBe("תקופת הניסיון של עסק במקסוז מסתיימת בקרוב");
    expect(mail.text).toBe(
      [
        "שלום יוסי,",
        "תקופת הניסיון של עסק במקסוז מסתיימת ביום שישי, 20 בנובמבר 2026.",
        "כדי להמשיך לעבוד בלי הפסקה, אפשר לבחור חבילה במסך החבילה:",
        links.plan,
        "",
        "—",
        footer("עסק"),
      ].join("\n"),
    );
    expect(mail.links).toEqual([links.plan]);
    expect(buildSignupEmail({ kind: "trial_ending", firstName: null, businessName: "עסק", trialEndDay: null, links })).toBeNull();
    expect(buildSignupEmail({ kind: "trial_ending", firstName: null, businessName: "עסק", trialEndDay: "2026-02-30", links })).toBeNull();
  });

  it("no offer, tip or price in either text (service only, owner (418) ב)", () => {
    for (const kind of ["welcome", "trial_ending"] as const) {
      const mail = buildSignupEmail({ kind, firstName: "דנה", businessName: "עסק", trialEndDay: "2026-11-21", links })!;
      expect(mail.text).not.toMatch(/הנחה|מבצע|טיפ|₪|%|חינם|הטבה/);
      expect(mail.text).toContain("זו הודעת שירות על החשבון, לא פרסומת.");
    }
  });

  it("with the neutral name the texts name no business: \"של העסק\" in the body and the footer", () => {
    const welcome = buildSignupEmail({ kind: "welcome", firstName: null, businessName: NEUTRAL_BUSINESS_NAME, trialEndDay: null, links })!;
    expect(welcome.subject).toBe("ברוכים הבאים למקסוז");
    expect(welcome.text).toContain("החשבון של העסק במקסוז נפתח.");
    expect(welcome.text.endsWith(footer("העסק"))).toBe(true);
    const ending = buildSignupEmail({ kind: "trial_ending", firstName: null, businessName: "", trialEndDay: "2026-11-21", links })!;
    expect(ending.subject).toBe("תקופת הניסיון במקסוז מסתיימת בקרוב");
    expect(ending.text).toContain("תקופת הניסיון של העסק במקסוז מסתיימת ביום שבת, 21 בנובמבר 2026.");
    expect(ending.text.endsWith(footer("העסק"))).toBe(true);
  });

  it("reads only real days", () => {
    expect(trialEndLabel("2026-11-21")).toBe("21 בנובמבר 2026");
    expect(trialEndWeekdayLabel("2026-11-22")).toBe("ביום ראשון, 22 בנובמבר 2026");
    expect(trialEndLabel("21/11/2026")).toBeNull();
    expect(trialEndWeekdayLabel(null)).toBeNull();
  });
});

describe("the signup.send handler", () => {
  const org = "11111111-2222-4333-8444-555555555555";
  const user = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const job = { id: "j1", lease: "l", kind: "signup.send" as const, organization_id: org, payload: { organization_id: org, user_id: user, kind: "trial_ending" }, attempt: 1 };
  const answer = { to: "owner@example.com", first_name: "דנה", business_name: "עסק", kind: "trial_ending", trial_end_day: "2026-11-21" };

  it("parses only the composer's own shape", () => {
    expect(parseSignupComposed(answer)).toEqual({ ok: true, to: "owner@example.com", firstName: "דנה", businessName: "עסק", kind: "trial_ending", trialEndDay: "2026-11-21" });
    expect(parseSignupComposed({ ...answer, first_name: null })).toMatchObject({ ok: true, firstName: null });
    expect(parseSignupComposed({ ...answer, first_name: 7 })).toBeNull();
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
    expect(sent[1].emailContent!.links).toEqual([
      `https://mexuzsystem.com/o/${org}/settings/users`,
      `https://mexuzsystem.com/o/${org}/settings/intake`,
      `https://mexuzsystem.com/o/${org}/settings/import`,
      `https://mexuzsystem.com/o/${org}`,
    ]);
    expect(sent[1].emailContent!.text.split("\n")[0]).toBe("שלום דנה,");
    expect(sent[0].emailContent!.fromName).toBe("מקסוז");

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
