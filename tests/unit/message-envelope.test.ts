import { describe, expect, it } from "vitest";

import { businessAddressLine, MARKETING_SENDER_LINE, MARKETING_UNSUBSCRIBE_LINE, marketingEnvelope } from "@/features/message-templates/envelope";
import { unknownMergeFields } from "@/features/message-templates/fields";

const tail = `\n\n${MARKETING_SENDER_LINE}\n${MARKETING_UNSUBSCRIBE_LINE}`;

describe("marketingEnvelope (MSG-02, owner (88))", () => {
  it("leaves every service type unchanged", () => {
    for (const messageType of ["meeting_reminder", "requested_document", "collection", "verification_code"] as const) {
      expect(marketingEnvelope({ channel: "email", messageType, subject: "נושא", body: "גוף" })).toEqual({ subject: "נושא", body: "גוף" });
      expect(marketingEnvelope({ channel: "sms", messageType, subject: null, body: "גוף" })).toEqual({ subject: null, body: "גוף" });
    }
  });

  it("wraps a review request like marketing (owner (321) א), and leaves the newer service types unchanged", () => {
    const wrapped = marketingEnvelope({ channel: "sms", messageType: "review_request", subject: null, body: "נשמח לביקורת" });
    expect(wrapped.body).toBe(marketingEnvelope({ channel: "sms", messageType: "marketing", subject: null, body: "נשמח לביקורת" }).body);
    expect(wrapped.body.startsWith("פרסומת: ")).toBe(true);
    for (const messageType of ["punch_card_notice", "instant_reply"] as const) {
      expect(marketingEnvelope({ channel: "sms", messageType, subject: null, body: "גוף" })).toEqual({ subject: null, body: "גוף" });
    }
  });

  it("an email: prefixes the subject once and appends the sender and unsubscribe lines", () => {
    expect(
      marketingEnvelope({ channel: "email", messageType: "marketing", subject: "חדש ב{שם העסק}", body: "שלום {שם פרטי}, {תוכן העדכון}" }),
    ).toEqual({
      subject: "פרסומת: חדש ב{שם העסק}",
      body: `שלום {שם פרטי}, {תוכן העדכון}${tail}`,
    });
    expect(marketingEnvelope({ channel: "email", messageType: "marketing", subject: "פרסומת: חדש", body: "x" }).subject).toBe("פרסומת: חדש");
    expect(marketingEnvelope({ channel: "email", messageType: "marketing", subject: "פרסומת - חדש", body: "x" }).subject).toBe("פרסומת - חדש");
  });

  it("SMS and WhatsApp have no subject: the text itself starts with פרסומת", () => {
    for (const channel of ["sms", "whatsapp"] as const) {
      const out = marketingEnvelope({ channel, messageType: "marketing", subject: null, body: "מבצע" });
      expect(out).toEqual({ subject: null, body: `פרסומת: מבצע${tail}` });
      expect(marketingEnvelope({ channel, messageType: "marketing", subject: null, body: "פרסומת: מבצע" }).body).toBe(`פרסומת: מבצע${tail}`);
    }
  });

  it("never doubles the parts a template already holds", () => {
    const own = `שלום\n${MARKETING_SENDER_LINE}\nלהסרה כתבו לנו: {קישור הסרה}`;
    expect(marketingEnvelope({ channel: "email", messageType: "marketing", subject: "s", body: own }).body).toBe(own);
    const onlySender = `שלום\n  ${MARKETING_SENDER_LINE}  `;
    expect(marketingEnvelope({ channel: "email", messageType: "marketing", subject: "s", body: onlySender }).body).toBe(
      `${onlySender.trimEnd()}\n\n${MARKETING_UNSUBSCRIBE_LINE}`,
    );
    // applying it twice changes nothing
    const once = marketingEnvelope({ channel: "sms", messageType: "marketing", subject: null, body: "מבצע" });
    expect(marketingEnvelope({ channel: "sms", messageType: "marketing", ...once })).toEqual(once);
  });

  it("adds only known merge fields", () => {
    const out = marketingEnvelope({ channel: "email", messageType: "marketing", subject: "s", body: "b" });
    expect(unknownMergeFields(`${out.subject} ${out.body}`)).toEqual([]);
  });

  it("the address line", () => {
    expect(businessAddressLine({ addressLine: " הרצל 1 ", city: "תל אביב" })).toBe("הרצל 1, תל אביב");
    expect(businessAddressLine({ addressLine: null, city: " " })).toBeNull();
  });
});
