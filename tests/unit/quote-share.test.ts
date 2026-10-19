import { describe, expect, it } from "vitest";

import { currentNameIfChanged, NEW_LINK_WARNING, quoteCustomerName, quoteEmailText, quoteLinkMessage, quoteMailtoHref, quoteWhatsappHref, shareOrder } from "@/features/quotes/share";

// QUO-08 (owner, 18 October 2026): the link goes out by WhatsApp or email when the quote is sent; QUO-07 point 9: today's
// customer name beside the printed one.

const url = "https://crm.example/f/quote/abc";

describe("sending the customer's link", () => {
  it("warns that the previous link stops working", () => {
    expect(NEW_LINK_WARNING).toContain("הקישור הקודם יפסיק לעבוד");
  });

  it("opens WhatsApp with the customer's number when it is E.164, else lets the person pick the chat", () => {
    expect(quoteWhatsappHref(url, "QT-7", "+972501234567")).toBe(
      `https://wa.me/972501234567?text=${encodeURIComponent(`שלום, הצעת מחיר QT-7 מחכה לך בקישור הזה: ${url}`)}`,
    );
    expect(quoteWhatsappHref(url, null, null)).toBe(`https://wa.me/?text=${encodeURIComponent(`שלום, הצעת מחיר מחכה לך בקישור הזה: ${url}`)}`);
    expect(quoteWhatsappHref(url, null, "050-1234567")).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });

  it("writes an email in the business's name, addressed to a plain address only", () => {
    const { subject, body } = quoteEmailText(url, "QT-7", "ירח הפקות", "דנה");
    expect(subject).toBe("הצעת מחיר QT-7 מירח הפקות");
    expect(body.split("\n")).toEqual(["שלום דנה,", "", "הצעת מחיר QT-7 מחכה לך בקישור הזה:", url, "", "בברכה,", "ירח הפקות"]);
    expect(quoteEmailText(url, null, "ירח", null).body.startsWith("שלום,\n")).toBe(true);

    const href = quoteMailtoHref(url, "QT-7", "ירח הפקות", "דנה", "dana@example.co.il");
    expect(href.startsWith("mailto:dana@example.co.il?subject=")).toBe(true);
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(params.get("subject")).toBe(subject);
    expect(params.get("body")).toBe(body);
    // anything that could add a recipient or a header is left out; the person types the address
    for (const bad of ["a@b.co?bcc=x@y.co", "a@b.co,c@d.co", "a b@c.co", "a@b.co&cc=x@y.co", "no-at-sign"]) {
      expect(quoteMailtoHref(url, null, "ירח", null, bad).startsWith("mailto:?subject="), bad).toBe(true);
    }
    expect(quoteMailtoHref(url, null, "ירח", null, null).startsWith("mailto:?subject=")).toBe(true);
  });
});

describe("the customer's name now (quote_send's order; test 158 compares with the database)", () => {
  const contact = { fullName: "דנה כהן", billingName: null, companyId: "c1" };
  const company = { name: "ירח", billingName: null };

  it("takes the first value in the rule's order", () => {
    expect(quoteCustomerName({ contact: { ...contact, billingName: "דנה לחשבונית" }, contactCompany: company, company: null })).toBe("דנה לחשבונית");
    expect(quoteCustomerName({ contact, contactCompany: { name: "ירח", billingName: "ירח בע\"מ" }, company: null })).toBe("ירח בע\"מ");
    expect(quoteCustomerName({ contact, contactCompany: company, company: { name: "אחרת" } })).toBe("ירח");
    expect(quoteCustomerName({ contact: { ...contact, companyId: null }, contactCompany: null, company: { name: "אחרת" } })).toBe("אחרת");
    expect(quoteCustomerName({ contact: { ...contact, companyId: null }, contactCompany: null, company: null })).toBe("דנה כהן");
    expect(quoteCustomerName({ contact: null, contactCompany: null, company: null })).toBeNull();
  });

  it("gives no name when the rule reaches a part the user may not read", () => {
    expect(quoteCustomerName({ contact: "hidden", contactCompany: null, company: { name: "x" } })).toBeNull();
    expect(quoteCustomerName({ contact, contactCompany: "hidden", company: null })).toBeNull();
    expect(quoteCustomerName({ contact: { ...contact, companyId: null }, contactCompany: null, company: "hidden" })).toBeNull();
    // a hidden part after the answer does not matter
    expect(quoteCustomerName({ contact: { ...contact, billingName: "דנה לחשבונית" }, contactCompany: "hidden", company: "hidden" })).toBe("דנה לחשבונית");
  });

  it("shows today's name only when both are known and differ", () => {
    expect(currentNameIfChanged("ירח", "ירח בע\"מ")).toBe("ירח בע\"מ");
    expect(currentNameIfChanged("ירח", " ירח ")).toBeNull();
    expect(currentNameIfChanged(null, "ירח")).toBeNull();
    expect(currentNameIfChanged("ירח", null)).toBeNull();
  });

  it("fills the WhatsApp message like a WA-01 template, leaving out a part that is missing", () => {
    expect(quoteLinkMessage(url, "QT-7", { customerName: "דנה כהן", senderName: "יוסי", businessName: "ירח הפקות" })).toBe(
      `שלום דנה, כאן יוסי מירח הפקות. הצעת מחיר QT-7 מחכה לך בקישור הזה: ${url}`,
    );
    expect(quoteLinkMessage(url, null, { businessName: "ירח הפקות" })).toBe(`שלום, כאן ירח הפקות. הצעת מחיר מחכה לך בקישור הזה: ${url}`);
    expect(quoteLinkMessage(url, "QT-7", { customerName: "  ", senderName: "יוסי" })).toBe(`שלום, כאן יוסי. הצעת מחיר QT-7 מחכה לך בקישור הזה: ${url}`);
    expect(quoteLinkMessage(url, "QT-7", { customerName: "דנה" })).not.toMatch(/[{}]/);
    expect(quoteWhatsappHref(url, "QT-7", null, { customerName: "דנה" })).toContain(encodeURIComponent("שלום דנה,"));
  });

  it("puts the contact's preferred channel first (CON-10)", () => {
    expect(shareOrder("email")).toEqual(["email", "whatsapp"]);
    for (const other of ["whatsapp", "phone", "sms", null, undefined, "x"]) expect(shareOrder(other)).toEqual(["whatsapp", "email"]);
  });
});
