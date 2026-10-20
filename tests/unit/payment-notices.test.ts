import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@/features/payments/schema";

// PAY-07: the notice names the method in Hebrew; app.payment_method_label (migration payment_notices) mirrors the screen's labels.
const dir = path.join(process.cwd(), "supabase/migrations");
const migration = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_payment_notices.sql"))!), "utf8");

describe("payment notice method labels (PAY-07)", () => {
  it("app.payment_method_label equals PAYMENT_METHOD_LABELS", () => {
    const fn = migration.slice(migration.indexOf("function app.payment_method_label"));
    const body = fn.slice(0, fn.indexOf("$$;"));
    const pairs = Object.fromEntries([...body.matchAll(/when '([a-z_]+)' then '((?:[^']|'')*)'/g)].map((m) => [m[1], m[2].replace(/''/g, "'")]));
    const other = /else '([^']*)' end/.exec(body)?.[1];
    const expected = Object.fromEntries(PAYMENT_METHODS.filter((m) => m !== "other").map((m) => [m, PAYMENT_METHOD_LABELS[m]]));
    expect(pairs).toEqual(expected);
    expect(other).toBe(PAYMENT_METHOD_LABELS.other);
  });
});
