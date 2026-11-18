import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GSM_BASIC, GSM_EXTENSION, smsSegments } from "@/features/messaging/sms-segments";
import { parseSmsBalance, SMS_PACKS, SMS_SERVICE_OVERDRAFT, smsBalanceLine } from "@/features/sms-balance/packs";

import cases from "./fixtures/sms-segments.json";

type Case = { text: string; repeat?: number; suffix?: string; segments: number };
const caseText = (c: Case) => c.text.repeat(c.repeat ?? 1) + (c.suffix ?? "");

const migration = () => {
  const dir = join(process.cwd(), "supabase/migrations");
  const file = readdirSync(dir).find((name) => name.endsWith("_sms_packs.sql"));
  expect(file).toBeDefined();
  return readFileSync(join(dir, file as string), "utf8");
};

describe("SMS segments (SMS-06), mirror of app.sms_segments", () => {
  it.each((cases as Case[]).map((c) => [c.text.slice(0, 20), c.repeat ?? 1, c]))("%s x%s", (_t, _n, c) => {
    expect(smsSegments(caseText(c as Case))).toBe((c as Case).segments);
  });

  it("the character sets are the migration's", () => {
    const sql = migration();
    const basic = GSM_BASIC.replace("'", "''").replace("\n", "' || chr(10) || '").replace("\r", "' || chr(13) || '");
    // the SQL writes the set in two quoted parts
    const [first, second] = [basic.slice(0, basic.indexOf("¡")), basic.slice(basic.indexOf("¡"))];
    expect(sql).toContain(`'${first}'`);
    expect(sql).toContain(`'${second}'`);
    expect(sql).toContain(`chr(12) || '${GSM_EXTENSION.slice(1)}'`);
  });

  it("the packs and the overdraft are the migration's", () => {
    const sql = migration();
    const packs = JSON.parse(/select '(\[\{"segments".*?\])'::jsonb/.exec(sql)?.[1] ?? "null");
    expect(packs).toEqual(SMS_PACKS.map((p) => ({ segments: p.segments, price_agorot: p.priceAgorot })));
    expect(sql).toContain(`as $$ select ${SMS_SERVICE_OVERDRAFT} $$`);
  });
});

describe("the balance answer (SMS-06)", () => {
  it("reads public.sms_balance_summary's answer and drops malformed movements", () => {
    expect(parseSmsBalance({ allowed: false })).toBeNull();
    expect(parseSmsBalance(null)).toBeNull();
    const b = parseSmsBalance({
      allowed: true,
      channel: "open",
      balance: 57,
      loaded: true,
      last_load: 300,
      low_at: 60,
      overdraft: 50,
      movements: [
        { kind: "charge", segments: -2, balance_after: 57, pack: null, at: "2026-11-18T10:00:00Z" },
        { kind: "bogus", segments: 1, balance_after: 1, at: "x" },
        { kind: "grant", segments: 300, balance_after: 59, pack: 300, at: "2026-11-17T10:00:00Z" },
      ],
    });
    expect(b).toEqual({
      channel: "open",
      balance: 57,
      loaded: true,
      lastLoad: 300,
      lowAt: 60,
      overdraft: 50,
      movements: [
        { kind: "charge", segments: -2, balanceAfter: 57, pack: null, at: "2026-11-18T10:00:00Z" },
        { kind: "grant", segments: 300, balanceAfter: 59, pack: 300, at: "2026-11-17T10:00:00Z" },
      ],
    });
  });

  it("says the state in one line", () => {
    const base = { channel: "open" as const, loaded: true, lastLoad: 300, lowAt: 60, overdraft: 50, movements: [] };
    expect(smsBalanceLine({ ...base, loaded: false, balance: 0 })).toContain("כבויה");
    expect(smsBalanceLine({ ...base, balance: -12 })).toContain("12");
    expect(smsBalanceLine({ ...base, balance: 0 })).toContain("24 שעות");
    expect(smsBalanceLine({ ...base, balance: 40 })).toBe("נשארו 40 מקטעי SMS.");
  });
});
