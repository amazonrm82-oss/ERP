import { describe, expect, it } from "vitest";

import { publicFormFrom } from "@/features/intake/public-form";
import { updateIntakeSchema } from "@/features/intake/schema";
import { whatsappChatUrl, whatsappNumber } from "@/features/intake/whatsapp";

// CAP-05: the thank-you page's WhatsApp button
describe("WhatsApp chat link (CAP-05)", () => {
  it("normalizes a typed number to E.164, or null when WhatsApp cannot open it", () => {
    expect(whatsappNumber("050-1234567")).toBe("+972501234567");
    expect(whatsappNumber("+972 52 765 4321")).toBe("+972527654321");
    expect(whatsappNumber("00972501234567")).toBe("+972501234567");
    expect(whatsappNumber("+1 (415) 555-0100")).toBe("+14155550100");
    for (const bad of [null, undefined, "", "abc", "12345", "+0501234567", "1".repeat(16)]) {
      expect(whatsappNumber(bad)).toBeNull();
    }
  });

  it("builds wa.me/<digits>, with the text encoded when there is one", () => {
    expect(whatsappChatUrl("+972501234567")).toBe("https://wa.me/972501234567");
    expect(whatsappChatUrl("+972501234567", "  ")).toBe("https://wa.me/972501234567");
    expect(whatsappChatUrl("+972501234567", "היי & שלום?")).toBe(
      `https://wa.me/972501234567?text=${encodeURIComponent("היי & שלום?")}`,
    );
    expect(whatsappChatUrl("+972501234567", "a b\nc")).toBe("https://wa.me/972501234567?text=a%20b%0Ac");
    // only a valid E.164 number gives a link
    for (const bad of [null, "", "972501234567", "+972-50", "+12", "javascript:alert(1)", "+972501234567/../x"]) {
      expect(whatsappChatUrl(bad, "x")).toBeNull();
    }
  });

  it("reads the link from intake_form()'s reply, and no button without a valid number", () => {
    const base = { title: "t", fields: [] };
    expect(publicFormFrom({ ...base, thanks: { whatsapp: "+972501234567", whatsapp_text: "היי" } })?.thanks).toEqual({
      whatsappUrl: `https://wa.me/972501234567?text=${encodeURIComponent("היי")}`,
    });
    for (const thanks of [{ whatsapp: null, whatsapp_text: "x" }, { whatsapp: "050" }, { whatsapp: 972501234567 }, "x", null, undefined]) {
      expect(publicFormFrom({ ...base, thanks })?.thanks).toEqual({ whatsappUrl: null });
    }
  });

  it("checks the settings of the form editor", () => {
    const form = {
      name: "טופס",
      title: "",
      intro: "",
      submit_label: "",
      success_message: "",
      redirect_url: "",
      source_id: "",
      owner_id: "",
      team_id: "",
      assign_mode: "owner",
      is_active: "on",
    };
    const ok = updateIntakeSchema.safeParse({ ...form, whatsapp_button: "on", whatsapp_phone: " 050-1234567 ", whatsapp_text: "היי" });
    expect(ok.success && ok.data).toMatchObject({ whatsapp_button: true, whatsapp_phone: "050-1234567", whatsapp_text: "היי" });
    const empty = updateIntakeSchema.safeParse({ ...form, whatsapp_button: null, whatsapp_phone: "", whatsapp_text: "" });
    expect(empty.success && empty.data).toMatchObject({ whatsapp_button: false, whatsapp_phone: null, whatsapp_text: null });
    for (const bad of ["12345", "abc", "050<1234567>"]) {
      expect(updateIntakeSchema.safeParse({ ...form, whatsapp_button: "on", whatsapp_phone: bad, whatsapp_text: "" }).success).toBe(false);
    }
    expect(updateIntakeSchema.safeParse({ ...form, whatsapp_button: "on", whatsapp_phone: "", whatsapp_text: "א".repeat(301) }).success).toBe(false);
  });
});
