import { afterAll, describe, expect, it } from "vitest";

import { normalizePhone } from "../../src/lib/phone";
import { asAdmin, closePool } from "./helpers";

afterAll(closePool);

// The app checks for repeat leads with normalizePhone(); the database stores
// phone_e164 with app.normalize_phone(). They must agree, or duplicates slip by.
describe("phone normalization: app and database agree", () => {
  const samples = [
    "050-123-4567",
    "0501234567",
    "+972 50 1234567",
    "972501234567",
    "00972-50-1234567",
    "03-5551234",
    "*6050",
    "+1 (415) 555-0100",
    "1-800-123",
    "abc",
    "",
    "  052.111.2222 ",
  ];

  it.each(samples)("%s", async (input) => {
    const db = await asAdmin(async (q) => (await q<{ v: string | null }>("select app.normalize_phone($1) as v", [input])).rows[0].v);
    expect(normalizePhone(input)).toBe(db);
  });
});
