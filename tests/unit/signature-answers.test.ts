import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IN_PERSON_EVIDENCE } from "@/features/in-person-signing/texts";

const MIGRATION = readFileSync(join(__dirname, "../../supabase/migrations/20261006021231_signature_answers.sql"), "utf8");
const ACTIONS = readFileSync(join(__dirname, "../../src/features/in-person-signing/actions.ts"), "utf8");

// The owner's answers of 12 November 2026 on SGN-04 and SGN-07 (migration 021230)
describe("signature answers (283), (287)-(290)", () => {
  it("the migration keeps the transport rules and grants nothing to anon", () => {
    expect(MIGRATION).not.toMatch(/^\s*drop\s/im);
    expect(MIGRATION).not.toMatch(/delete\s+from/i);
    expect(MIGRATION).not.toContain("\\u");
    expect(MIGRATION).not.toMatch(/grant execute on function [^;]* to anon/);
  });

  it("(287) ב: every in-person decision stores the device's IP from the server's header, and the screen says so", () => {
    expect(MIGRATION.match(/app\.in_person_device_ip\(\), left\(nullif\(btrim\(coalesce\(p_user_agent, ''\)\), ''\), 500\)/g)?.length).toBe(3);
    expect(MIGRATION).toContain("->> 'x-crm-device-ip'");
    // the action reads it as the public sign route does, and sends it on each of the three calls
    expect(ACTIONS).toContain('const DEVICE_IP_HEADER = "x-crm-device-ip"');
    expect(ACTIONS).toContain("clientIp(await headers())");
    expect(ACTIONS.match(/\.setHeader\(DEVICE_IP_HEADER, await deviceIp\(\)\)/g)?.length).toBe(3);
    expect(IN_PERSON_EVIDENCE).toContain("כתובת ה-IP");
  });

  it("(288) ב: the rep's window is 24 hours; no hour is left", () => {
    expect(MIGRATION.match(/now\(\) - interval '24 hours'/g)?.length).toBe(2);
    expect(MIGRATION).not.toContain("interval '1 hour'");
  });

  it("(283) ב: the renewal job closes expired contracts' tasks first, with the owner's wording", () => {
    expect(MIGRATION).toMatch(/begin\n    perform app\.close_expired_contract_renewals\(\);\n  exception when others then/);
    expect(MIGRATION).toContain("outcome = 'נסגרה: פג תוקף החוזה'");
  });
});
