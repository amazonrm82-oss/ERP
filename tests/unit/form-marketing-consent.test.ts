import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  formMarketingChannels,
  MARKETING_CONSENT_CHANNELS,
  MARKETING_CONSENT_INPUT,
  MARKETING_CONSENT_VERSION,
  marketingConsentFrom,
  marketingConsentInput,
  marketingConsentSetting,
  marketingConsentWording,
} from "@/features/intake/marketing-consent";
import { publicFormFrom } from "@/features/intake/public-form";

// CAP-07 / CNS-04: the app mirrors the migration's version, wording and channel rule (found by its suffix: the lead
// renumbers migrations at merge)
const dir = path.join(process.cwd(), "supabase/migrations");
const file = readdirSync(dir).find((name) => name.endsWith("_form_marketing_consent.sql"));
const sql = readFileSync(path.join(dir, file as string), "utf8");

describe("marketing-consent box mirrors (CAP-07, CNS-04)", () => {
  it("the version is the database's", () => {
    expect(sql).toContain(`select '${MARKETING_CONSENT_VERSION}'::text`);
  });

  it("the wording is built from the same pieces as app.marketing_consent_wording", () => {
    const body = /function app\.marketing_consent_wording[\s\S]*?\$\$([\s\S]*?)\$\$;/.exec(sql)?.[1] ?? "";
    expect(body).toContain("'אני מאשר/ת לקבל עדכונים ופרסומות '");
    expect(body).toContain("when 'email' then 'באימייל' when 'sms' then 'ב-SMS' when 'whatsapp' then 'בוואטסאפ'");
    expect(body).toContain("' מהעסק ' || coalesce(nullif(btrim(p_business), ''), 'הזה')");
    expect(body).toContain("'. אפשר לבטל את ההסכמה בכל עת.'");
    expect(marketingConsentWording("sms", " סטודיו ")).toBe("אני מאשר/ת לקבל עדכונים ופרסומות ב-SMS מהעסק סטודיו. אפשר לבטל את ההסכמה בכל עת.");
    expect(marketingConsentWording("email", "")).toBe("אני מאשר/ת לקבל עדכונים ופרסומות באימייל מהעסק הזה. אפשר לבטל את ההסכמה בכל עת.");
  });

  it("the channels equal the column's check and the fixed order of app.form_marketing_channels", () => {
    expect(sql).toContain(`marketing_consent_channels <@ array[${MARKETING_CONSENT_CHANNELS.map((c) => `'${c}'`).join(", ")}]::text[]`);
    expect(sql).toContain(`unnest(array[${MARKETING_CONSENT_CHANNELS.map((c) => `'${c}'`).join(", ")}]::text[]) with ordinality as c(channel, ord)`);
  });

  it("a box shows only while the form collects its address", () => {
    expect(formMarketingChannels(["whatsapp", "email", "sms"], ["full_name", "phone", "email"])).toEqual(["email", "sms", "whatsapp"]);
    expect(formMarketingChannels(["whatsapp", "email", "sms"], ["full_name", "email"])).toEqual(["email"]);
    expect(formMarketingChannels(["email"], ["phone"])).toEqual([]);
    expect(formMarketingChannels([], ["phone", "email"])).toEqual([]);
  });

  it("reads intake_form's boxes, dropping anything malformed", () => {
    expect(marketingConsentFrom(null)).toBeNull();
    expect(marketingConsentFrom({ version: "v", channels: [] })).toBeNull();
    expect(
      marketingConsentFrom({
        version: "form-draft-1",
        channels: [{ channel: "sms", text: "א" }, { channel: "fax", text: "ב" }, { channel: "sms", text: "ג" }, { channel: "email", text: " " }],
      }),
    ).toEqual({ version: "form-draft-1", boxes: [{ channel: "sms", text: "א" }] });
    const form = publicFormFrom({
      title: "t",
      fields: [{ key: "phone", required: true }],
      marketing_consent: { version: "form-draft-1", channels: [{ channel: "whatsapp", text: "נוסח" }] },
    });
    expect(form?.marketingConsent).toEqual({ version: "form-draft-1", boxes: [{ channel: "whatsapp", text: "נוסח" }] });
    expect(publicFormFrom({ title: "t", fields: [] })?.marketingConsent).toBeNull();
  });

  it("a post keeps only ticked boxes the form shows", () => {
    const offer = { version: "v", boxes: [{ channel: "email" as const, text: "a" }, { channel: "sms" as const, text: "b" }] };
    expect(marketingConsentInput(["sms", "whatsapp", "fax"], offer)).toEqual(["sms"]);
    expect(marketingConsentInput("email", offer)).toEqual(["email"]);
    expect(marketingConsentInput(undefined, offer)).toEqual([]);
    expect(marketingConsentInput(["email"], null)).toEqual([]);
    expect(marketingConsentInput({ email: "on" }, offer)).toEqual([]);
  });

  it("the settings form gives the ticked channels in order", () => {
    const data = new FormData();
    data.set(`${MARKETING_CONSENT_INPUT}_whatsapp`, "on");
    data.set(`${MARKETING_CONSENT_INPUT}_email`, "on");
    expect(marketingConsentSetting(data)).toEqual(["email", "whatsapp"]);
    expect(marketingConsentSetting(new FormData())).toEqual([]);
  });

  it("intake_submit reads the payload key the hosted form sends", () => {
    expect(sql).toContain(`p_payload -> '${MARKETING_CONSENT_INPUT}'`);
  });
});
