import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { smsSenderSchema } from "@/features/message-sending/schema";
import { createInforuProvider } from "@/features/messaging/providers/inforu";
import { messagingProviderFor } from "@/features/messaging/providers/select";
import { createSms4FreeProvider } from "@/features/messaging/providers/sms4free";
import { smsSenderFor } from "@/features/messaging/providers/sms-stub";
import {
  israeliE164,
  senderCheckMessage,
  SMS_SENDER_PENDING,
  smsSenderIsNumber,
  smsSenderNameInput,
  smsSenderNameOk,
  smsSenderState,
} from "@/features/messaging/sms-sender";

import cases from "./fixtures/sms-sender-names.json";

const root = join(__dirname, "..", "..");

describe("SMS-01: the sender name rule (shared fixture with app.sms_sender_name_ok)", () => {
  it.each(cases.ok)("accepts %j", (value) => expect(smsSenderNameOk(value)).toBe(true));
  it.each(cases.bad)("refuses %j", (value) => expect(smsSenderNameOk(value)).toBe(false));

  it("refuses what is not a string", () => {
    expect(smsSenderNameOk(null)).toBe(false);
    expect(smsSenderNameOk(undefined)).toBe(false);
  });

  it("the migration holds the same patterns as the TS rule", () => {
    const dir = join(root, "supabase", "migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_sms_a_sender.sql"));
    expect(file).toBeDefined();
    const sql = readFileSync(join(dir, file as string), "utf8");
    for (const pattern of ["^[A-Za-z0-9]{2,11}$", "[A-Za-z]", "^0[2-9][0-9]{7,8}$", "^[+]?972[2-9][0-9]{7,8}$", "^1[78]00[0-9]{6}$"]) {
      expect(sql, pattern).toContain(`'${pattern}'`);
    }
  });

  it("the form trims, takes a phone's spaces and dashes out, and stores empty as none", () => {
    expect(smsSenderNameInput("  MyShop ")).toBe("MyShop");
    expect(smsSenderNameInput("050-123 4567")).toBe("0501234567");
    expect(smsSenderSchema.parse({ sms_sender_name: "" })).toEqual({ sms_sender_name: null });
    expect(smsSenderSchema.parse({ sms_sender_name: " 050-1234567 " })).toEqual({ sms_sender_name: "0501234567" });
    expect(smsSenderSchema.safeParse({ sms_sender_name: "My Shop" }).success).toBe(false);
    expect(smsSenderSchema.safeParse({ sms_sender_name: "123456" }).success).toBe(false);
  });
});

describe("SMS-01: the InforU and SMS4Free adapters are stubs", () => {
  const inforuKeys = { INFORU_USERNAME: "u", INFORU_API_TOKEN: "t" };
  const sms4freeKeys = { SMS4FREE_KEY: "k", SMS4FREE_USER: "u", SMS4FREE_PASS: "p" };

  it("refuse to start without every one of their own keys", () => {
    expect(createInforuProvider({})).toBeNull();
    expect(createInforuProvider({ INFORU_USERNAME: "u" })).toBeNull();
    expect(createInforuProvider({ INFORU_USERNAME: "u", INFORU_API_TOKEN: "  " })).toBeNull();
    expect(createSms4FreeProvider({ SMS4FREE_KEY: "k", SMS4FREE_USER: "u" })).toBeNull();
    // another provider's keys are not theirs
    expect(createInforuProvider(sms4freeKeys)).toBeNull();
    expect(createSms4FreeProvider(inforuKeys)).toBeNull();
  });

  it("with their keys, send nothing and answer a retryable failure", async () => {
    const inforu = createInforuProvider(inforuKeys);
    expect(inforu).toMatchObject({ name: "inforu", channel: "sms" });
    const result = await inforu!.send({
      jobId: "j",
      organizationId: "o",
      channel: "sms",
      messageType: "marketing",
      purpose: "marketing",
      recordType: "lead",
      recordId: "r",
    });
    expect(result).toEqual({ ok: false, error: "the adapter is not built yet", code: "adapter_not_built", final: false });
    expect(createSms4FreeProvider(sms4freeKeys)).toMatchObject({ name: "sms4free", channel: "sms" });
  });

  it("are never chosen by the provider layer, even with their keys (not built)", () => {
    expect(messagingProviderFor("sms", { MESSAGING_PROVIDER_SMS: "inforu", ...inforuKeys })).toBeNull();
    expect(messagingProviderFor("sms", { MESSAGING_PROVIDER_SMS: "sms4free", ...sms4freeKeys })).toBeNull();
    // and never for another channel
    expect(messagingProviderFor("email", { MESSAGING_PROVIDER: "inforu", ...inforuKeys })).toBeNull();
    expect(messagingProviderFor("sms", { MESSAGING_PROVIDER_SMS: "fake" })?.name).toBe("fake");
  });

  it("send under the business's sender name when it is valid, else the platform's default", () => {
    expect(smsSenderFor("MyShop", "Mexuz")).toBe("MyShop");
    expect(smsSenderFor(null, "Mexuz")).toBe("Mexuz");
    expect(smsSenderFor("bad name", " Mexuz ")).toBe("Mexuz");
    expect(smsSenderFor(null, "")).toBeNull();
    expect(smsSenderFor(null, undefined)).toBeNull();
  });

  it("only the adapter files read the providers' keys", () => {
    const names = ["INFORU_USERNAME", "INFORU_API_TOKEN", "INFORU_SENDER", "SMS4FREE_KEY", "SMS4FREE_USER", "SMS4FREE_PASS", "SMS4FREE_SENDER"];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : []));
    const allowed = new Set(["inforu.ts", "sms4free.ts"].map((f) => join(root, "src", "features", "messaging", "providers", f)));
    for (const file of walk(join(root, "src"))) {
      if (allowed.has(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const name of names) expect(text.includes(name), `${file} names ${name}`).toBe(false);
    }
  });
});

describe("SMS-01b: the sender's state (owner (211) א)", () => {
  it("an approved letter name goes; a pending one waits and the verified number goes meanwhile", () => {
    const base = { verifiedPhone: "+972527770001", businessPhone: "052-7770001" };
    expect(smsSenderState({ ...base, name: "MyShop", approved: true })).toMatchObject({ nameState: "approved", effective: "MyShop" });
    expect(smsSenderState({ ...base, name: "MyShop", approved: false })).toMatchObject({ nameState: "pending", effective: "+972527770001" });
    expect(smsSenderState({ ...base, name: "0527770001", approved: false })).toMatchObject({ nameState: "number", effective: "+972527770001" });
    expect(smsSenderState({ ...base, name: null, approved: false })).toMatchObject({ nameState: "none", effective: "+972527770001" });
    // review (3): a rejected name is told as rejected, and the verified number goes
    expect(smsSenderState({ ...base, name: "MyShop", approved: false, rejected: true })).toMatchObject({ nameState: "rejected", effective: "+972527770001" });
  });

  it("a verified number counts only while it is the business's phone; none = the platform default", () => {
    expect(smsSenderState({ name: "MyShop", approved: false, verifiedPhone: "+972527770001", businessPhone: "03-1234567" })).toMatchObject({
      verifiedPhone: null,
      effective: null,
    });
    expect(smsSenderState({ name: null, approved: false, verifiedPhone: null, businessPhone: null }).effective).toBeNull();
    expect(israeliE164("052-777 0001")).toBe("+972527770001");
    expect(israeliE164("+972527770001")).toBe("+972527770001");
    expect(israeliE164("1700123456")).toBeNull();
    expect(smsSenderIsNumber("0527770001")).toBe(true);
    expect(smsSenderIsNumber("MyShop")).toBe(false);
  });

  it("every answer of the check reads in Hebrew", () => {
    expect(senderCheckMessage({ ok: true }).ok).toBe(true);
    for (const reason of ["no_phone", "cooldown", "rate", "no_code", "expired", "wrong", "other"]) {
      expect(senderCheckMessage({ ok: false, reason }).message).toMatch(/[א-ת]/);
    }
    expect(senderCheckMessage({ ok: false, reason: "wrong", left: 2 }).message).toContain("2");
    expect(SMS_SENDER_PENDING).toBe("ממתין לאישור הספק");
  });
});
