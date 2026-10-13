#!/usr/bin/env node
// Checks that the database tests have teeth.
//
// For every RLS policy it creates a temporary migration that replaces the
// policy with "allow everything", runs the database tests, and expects them
// to FAIL. A policy whose weakening goes unnoticed is reported as a gap in
// the tests. Slow (one full test run per policy); run it after changing
// policies, not on every commit.
//
//   npm run db:test:start && node scripts/policy-mutation-sweep.mjs [table-filter]
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/crm_saas_test";
const mutationFile = path.join(root, "supabase/migrations/29990101000000_mutation.sql");
const filter = process.argv[2];

const runTests = () =>
  spawnSync("npx", ["vitest", "run", "--config", "vitest.db.config.mts"], { cwd: root, encoding: "utf8" });

// a clean run first: builds the database and proves the baseline is green
rmSync(mutationFile, { force: true });
const baseline = runTests();
if (baseline.status !== 0) {
  console.error("Baseline tests are failing; fix them before running the sweep.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows: policies } = await client.query(
  `select tablename, policyname, cmd from pg_policies where schemaname = 'public' order by tablename, policyname`,
);
await client.end();

// Mutations that change nothing, so no test can (or should) notice them.
const equivalent = new Set([
  "plans.plans_select", // already "using (true)": the price list is the same for everyone
  "vat_rates.vat_rates_select", // already "using (true)": the VAT rate is the law, the same for everyone (TAX-03)
  // user_id has no insert grant and a trigger sets it from the session, so the policy cannot be bypassed
  "push_subscriptions.push_subscriptions_insert",
]);

const survivors = [];
try {
  for (const p of policies) {
    if (filter && !p.tablename.includes(filter)) continue;
    if (equivalent.has(`${p.tablename}.${p.policyname}`)) continue;
    const using = p.cmd === "INSERT" ? "" : " using (true)";
    const check = p.cmd === "INSERT" || p.cmd === "UPDATE" || p.cmd === "ALL" ? " with check (true)" : "";
    writeFileSync(
      mutationFile,
      `drop policy ${p.policyname} on public.${p.tablename};\n` +
        `create policy ${p.policyname} on public.${p.tablename} for ${p.cmd} to authenticated${using}${check};\n`,
    );
    const result = runTests();
    const caught = result.status !== 0;
    console.log(`${caught ? "caught  " : "MISSED  "} ${p.tablename}.${p.policyname} (${p.cmd})`);
    if (!caught) survivors.push(`${p.tablename}.${p.policyname}`);
  }
} finally {
  rmSync(mutationFile, { force: true });
}

console.log(`\n${policies.length} policies, ${survivors.length} weakening(s) not caught by the tests.`);
if (survivors.length) {
  console.log(survivors.map((s) => `  - ${s}`).join("\n"));
  process.exit(2);
}
