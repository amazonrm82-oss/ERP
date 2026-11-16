import { describe, expect, it } from "vitest";

import { emailQueueText, MAX_INVITES, parseInviteAddresses } from "@/features/invitations/addresses";
import { buildInvitationEmail, INVITATION_EMAIL_WORDING, invitationExpiryLabel, NEUTRAL_BUSINESS_NAME } from "@/features/invitations/email";
import { FAILED_AFTER_COMPOSE, FAILED_BEFORE_COMPOSE, invitationEmailLine, parseInvitationEmailStatus } from "@/features/invitations/email-status";
import { createInvitationHandler, parseInvitationComposed } from "@/features/invitations/send-handler";
import type { OutgoingMessage } from "@/features/messaging/providers/types";

// USR-09 (owner (387) א): several addresses at once, the fixed service text, and the invite.send handler.

describe("the addresses", () => {
  it("splits, folds, dedupes and caps at 20", () => {
    expect(parseInviteAddresses(" A@x.co, b@x.co;\nA@X.co  c@x.co ")).toEqual({ ok: true, emails: ["a@x.co", "b@x.co", "c@x.co"] });
    expect(parseInviteAddresses("")).toMatchObject({ ok: false });
    expect(parseInviteAddresses(null)).toMatchObject({ ok: false });
    expect(parseInviteAddresses("a@x.co, nope")).toEqual({ ok: false, message: "כתובות לא תקינות: nope" });
    const many = Array.from({ length: MAX_INVITES + 1 }, (_, i) => `u${i}@x.co`).join(",");
    expect(parseInviteAddresses(many)).toEqual({ ok: false, message: "אפשר להזמין עד 20 כתובות בבת אחת." });
    expect(parseInviteAddresses(Array.from({ length: MAX_INVITES }, (_, i) => `u${i}@x.co`).join(","))).toMatchObject({ ok: true });
  });

  it("every answer of the queue has a Hebrew line", () => {
    expect(emailQueueText(null)).toBeNull();
    for (const reason of ["unavailable", "rate", "rate_business", "rate_requester", "error"]) expect(emailQueueText(reason)).toMatch(/[א-ת]/);
    expect(emailQueueText("rate_requester")).not.toBe(emailQueueText("error"));
  });
});

describe("the fixed text", () => {
  const link = `https://mexuzsystem.com/invite/${"a".repeat(64)}`;

  it("names the business, the role, the link and the last day; a DRAFT with a version", () => {
    const mail = buildInvitationEmail({ businessName: "עסק‮ שלי", role: "member", expiresAt: "2026-11-23T10:00:00Z", link })!;
    expect(INVITATION_EMAIL_WORDING).toBe("invite-draft-1");
    expect(mail.subject).toBe("הזמנה להצטרף לעסק שלי במקסוז");
    expect(mail.text).toBe(
      [
        "שלום,",
        "הוזמנת להצטרף לעסק עסק שלי במערכת מקסוז, בתפקיד משתמש.",
        "",
        `להצטרפות: ${link}`,
        "הקישור בתוקף עד 23 בנובמבר 2026, ומתאים רק לכתובת המייל הזו.",
        "",
        "אם לא ציפית להזמנה הזו, אפשר להתעלם מהמייל.",
        "—",
        "המייל נשלח ממקסוז לבקשת עסק שלי. אין להשיב למייל הזה.",
      ].join("\n"),
    );
    expect(mail.links).toEqual([link]);
  });

  it("with the neutral name (a business name that held a link) the text names no business (delta review 1b)", () => {
    const mail = buildInvitationEmail({ businessName: NEUTRAL_BUSINESS_NAME, role: "member", expiresAt: "2026-11-23T10:00:00Z", link })!;
    expect(mail.subject).toBe("הזמנה להצטרף לעסק במקסוז");
    expect(mail.text).toContain("הוזמנת להצטרף לעסק במערכת מקסוז, בתפקיד משתמש.");
    expect(mail.text).toContain("המייל נשלח ממקסוז לבקשת העסק.");
    expect(mail.text).not.toContain("להעסק");
  });

  it("builds nothing for an owner or a bad date", () => {
    expect(buildInvitationEmail({ businessName: "ע", role: "owner", expiresAt: "2026-11-23T10:00:00Z", link })).toBeNull();
    expect(buildInvitationEmail({ businessName: "ע", role: "admin", expiresAt: "tomorrow", link })).toBeNull();
    expect(invitationExpiryLabel("2026-11-23T23:30:00Z")).toBe("24 בנובמבר 2026");
  });
});

describe("the invite.send handler", () => {
  const job = { id: "11111111-2222-4333-8444-555555555555", lease: "l", kind: "invite.send" as const, organization_id: "o", payload: { invitation_id: "i", requested_by: "u" }, attempt: 1 };
  const token = "b".repeat(64);
  const answer = { to: "new@example.com", business_name: "עסק", role: "manager", expires_at: "2026-11-23T10:00:00Z", token };

  it("parses only the composer's own shape", () => {
    expect(parseInvitationComposed(answer)).toMatchObject({ ok: true, role: "manager", token });
    expect(parseInvitationComposed({ ...answer, role: "owner" })).toBeNull();
    expect(parseInvitationComposed({ ...answer, token: "short" })).toBeNull();
    expect(parseInvitationComposed({ refused: "not_pending" })).toEqual({ ok: false, code: "not_pending" });
  });

  it("sends the fixed text with the composer's new link, never the token anywhere else; a refusal sends nothing", async () => {
    const sent: OutgoingMessage[] = [];
    const provider = { name: "fake", channel: "email" as const, send: async (m: OutgoingMessage) => (sent.push(m), { ok: true as const, providerId: "p1" }) };
    const done = await createInvitationHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => answer })(job);
    expect(done).toEqual({ status: "done", receipt: { provider: "fake", providerMessageId: "p1" } });
    const mail = sent[0].emailContent!;
    expect(mail.to).toBe("new@example.com");
    expect(mail.text).toContain(`https://mexuzsystem.com/invite/${token}`);
    expect(mail.subject).not.toContain(token);
    expect(mail.replyTo).toBeNull();
    expect(sent[0].recordType).toBe("invitation");
    expect(JSON.stringify(done)).not.toContain(token);
    const refused = await createInvitationHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => ({ refused: "expired" }) })(job);
    expect(refused).toMatchObject({ status: "failed", final: true, receipt: { provider: null, errorCode: "expired" } });
    const failed = await createInvitationHandler({
      provider: { ...provider, send: async () => ({ ok: false as const, error: "boom", code: "x" }) },
      siteOrigin: () => "https://mexuzsystem.com",
      compose: async () => answer,
    })(job);
    expect(JSON.stringify(failed)).not.toContain(token);
    expect(sent).toHaveLength(1);
  });
});

describe("the line about the latest email (review fix 3)", () => {
  it("says the earlier link is dead only when a send failed after its token was minted", () => {
    expect(invitationEmailLine(null)).toBeNull();
    expect(invitationEmailLine({ state: "sent", composed: true, whenText: "16 בנוב׳" })).toBe("נשלחה במייל ב-16 בנוב׳");
    expect(invitationEmailLine({ state: "waiting", composed: false, whenText: "x" })).toBe("נשלחת במייל (התבקשה ב-x)");
    expect(invitationEmailLine({ state: "waiting", composed: true, whenText: "x" })).toBe("נשלחת במייל (התבקשה ב-x). הקישור הקודם כבר לא פעיל.");
    expect(invitationEmailLine({ state: "failed", composed: true, whenText: "x" })).toBe(FAILED_AFTER_COMPOSE);
    expect(FAILED_AFTER_COMPOSE).toBe("השליחה נכשלה; הקישור הקודם כבר לא פעיל — שלחו שוב או צרו הזמנה חדשה");
    expect(invitationEmailLine({ state: "failed", composed: false, whenText: "x" })).toBe(FAILED_BEFORE_COMPOSE);
    expect(FAILED_BEFORE_COMPOSE).toBe("השליחה נכשלה; שלחו שוב או צרו הזמנה חדשה");
  });

  it("reads only the database's own row shape", () => {
    expect(parseInvitationEmailStatus({ invitation_id: "i", last_requested_at: "2026-11-16T10:00:00Z", state: "failed", composed: true })).toEqual({
      invitationId: "i",
      lastRequestedAt: "2026-11-16T10:00:00Z",
      state: "failed",
      composed: true,
    });
    expect(parseInvitationEmailStatus({ invitation_id: "i", last_requested_at: "t", state: "lost" })).toBeNull();
    expect(parseInvitationEmailStatus(null)).toBeNull();
  });
});
