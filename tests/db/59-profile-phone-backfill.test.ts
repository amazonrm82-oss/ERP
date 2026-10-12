import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, closePool, createUser, TEST_DB_URL } from "./helpers";

afterAll(closePool);

const MIGRATION = readFileSync(join(process.cwd(), "supabase/migrations/20261006008700_profile_phone_backfill.sql"), "utf8");

/** Runs the migration text on its own connection and returns its notices. */
async function runBackfill(): Promise<string[]> {
  const client = new Client({ connectionString: TEST_DB_URL });
  const notices: string[] = [];
  client.on("notice", (n) => notices.push(n.message ?? ""));
  await client.connect();
  try {
    await client.query("begin");
    await client.query(MIGRATION);
    await client.query("commit");
    return notices;
  } finally {
    await client.end();
  }
}

const counts = (notices: string[]) => {
  const m = notices.join("\n").match(/filled (\d+), still without a normalized phone (\d+), profiles with a phone (\d+)/);
  return m ? { filled: Number(m[1]), missing: Number(m[2]), withPhone: Number(m[3]) } : undefined;
};

const OLD_UPDATED_AT = "2026-01-01T08:00:00.000Z";

/** A profile as it was saved before 0066: no trigger set phone_e164. */
async function oldProfile(phone: string | null, e164: string | null = null): Promise<string> {
  const user = await createUser("ph");
  await asAdmin(async (q) => {
    await q("set local session_replication_role = replica");
    await q("update public.profiles set phone = $2, phone_e164 = $3, updated_at = $4 where id = $1", [user.id, phone, e164, OLD_UPDATED_AT]);
  });
  return user.id;
}

type Row = { phone: string | null; phone_e164: string | null; updated_at: Date };
const row = (id: string) =>
  asAdmin(async (q) => (await q<Row>("select phone, phone_e164, updated_at from public.profiles where id = $1", [id])).rows[0]);

// USR-01 backfill (owner's go-ahead of 12 October 2026): only numbers that normalize without doubt.
describe("one-time fill of normalized phones in profiles (USR-01)", () => {
  it("fills clear numbers only, keeps the typed phone and updated_at, reports counts, and runs twice harmlessly", async () => {
    const good: Record<string, string> = {
      "050-123-4567": "+972501234567",
      "02 123 4567": "+97221234567",
      "+972 54 1234567": "+972541234567",
      "00972-52-1234567": "+972521234567",
      "972501234567": "+972501234567",
      "(03) 1234567": "+97231234567",
      "+1 (212) 555-1234": "+12125551234",
      "0044 20 7946 0958": "+442079460958",
    };
    const doubtful = [
      "501234567", // local without a leading 0
      "1234", // too short
      "050-123", // too short
      "050123456789", // too long for a local number
      "+972 050 1234567", // trunk 0 after the country code
      "050-1234567 / 052-7654321", // two numbers
      "050-1234567 שלוחה 3", // text mixed in
      "+1 23", // international, too short
      "+12345678901234567", // longer than E.164
      "050123456", // mobile one digit short
      "071234567", // 07X one digit short
      "0312345678", // landline one digit too many
      "+44 (0) 20 7946 0958", // optional trunk 0
      "(00) 12345678", // "(0)"-style prefix, not international
    ];
    const garbage = ["abc", "---", "טלפון"];

    const goodIds = new Map<string, string>();
    for (const phone of Object.keys(good)) goodIds.set(phone, await oldProfile(phone));
    const doubtIds = new Map<string, string>();
    for (const phone of [...doubtful, ...garbage]) doubtIds.set(phone, await oldProfile(phone));
    const empty = [await oldProfile(null), await oldProfile(""), await oldProfile("   ")];
    // a value already there is never touched, even if it differs from what the phone would give
    const alreadySet = await oldProfile("050-1234567", "+972500000000");

    const first = counts(await runBackfill());
    expect(first).toBeDefined();
    expect(first!.filled).toBeGreaterThanOrEqual(Object.keys(good).length);
    expect(first!.missing).toBeGreaterThanOrEqual(doubtful.length + garbage.length);
    expect(first!.withPhone).toBeGreaterThanOrEqual(first!.filled + first!.missing);

    for (const [phone, id] of goodIds) {
      const r = await row(id);
      expect(r.phone_e164, phone).toBe(good[phone]);
      expect(r.phone, phone).toBe(phone);
      expect(r.updated_at.toISOString(), phone).toBe(OLD_UPDATED_AT);
    }
    for (const [phone, id] of doubtIds) {
      const r = await row(id);
      expect(r.phone_e164, phone).toBeNull();
      expect(r.phone, phone).toBe(phone);
      expect(r.updated_at.toISOString(), phone).toBe(OLD_UPDATED_AT);
    }
    for (const id of empty) {
      expect((await row(id)).phone_e164).toBeNull();
    }
    expect((await row(alreadySet)).phone_e164).toBe("+972500000000");

    // the filled value is exactly what the live trigger writes for the same phone
    const userId = goodIds.get("050-123-4567")!;
    const live = await asAdmin(async (q) => {
      await q("update public.profiles set phone = phone where id = $1", [userId]);
      return (await q<{ phone_e164: string }>("select phone_e164 from public.profiles where id = $1", [userId])).rows[0].phone_e164;
    });
    expect(live).toBe("+972501234567");

    // the touch trigger is back on: a normal save moves updated_at again
    const enabled = await asAdmin(async (q) =>
      (await q<{ tgenabled: string }>("select tgenabled from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'profiles_touch'")).rows[0].tgenabled,
    );
    expect(enabled).toBe("O");
    expect((await row(userId)).updated_at.toISOString()).not.toBe(OLD_UPDATED_AT);

    // the second run changes nothing
    const snapshot = async () => Promise.all([...goodIds.values(), ...doubtIds.values(), ...empty, alreadySet].map(row));
    const before = await snapshot();
    const second = counts(await runBackfill());
    expect(second?.filled).toBe(0);
    expect(second?.missing).toBe(first!.missing);
    expect(await snapshot()).toEqual(before);
  });
});
