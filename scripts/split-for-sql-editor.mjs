#!/usr/bin/env node
// Splits a migration into parts short enough to paste into the Supabase SQL Editor
// (a paste of ~4,000+ characters was cut off on the owner's machine). Splits only
// between top-level statements, never inside a $$ function body.
//
//   node scripts/split-for-sql-editor.mjs supabase/migrations/<file>.sql
// Writes supabase/handoff/<file>/partN.sql and prints each part's length.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX = 3500;
const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/split-for-sql-editor.mjs <migration.sql>");
  process.exit(1);
}
const name = path.basename(file, ".sql");
const lines = readFileSync(file, "utf8").split("\n");

// statements: runs of lines ending with ';' outside a $$ body
const statements = [];
let current = [];
let inBody = false;
for (const line of lines) {
  current.push(line);
  const dollars = (line.match(/\$\$/g) ?? []).length;
  if (dollars % 2 === 1) inBody = !inBody;
  if (!inBody && /;\s*(--.*)?$/.test(line)) {
    statements.push(current.join("\n"));
    current = [];
  }
}
if (current.join("").trim()) statements.push(current.join("\n"));

const parts = [];
let part = "";
for (const statement of statements) {
  if (part && part.length + statement.length + 1 > MAX) {
    parts.push(part);
    part = "";
  }
  part = part ? `${part}\n${statement}` : statement;
}
if (part.trim()) parts.push(part);

const outDir = path.join("supabase/handoff", name);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
let tooLong = false;
parts.forEach((text, i) => {
  const body = `-- ${name}: part ${i + 1} of ${parts.length}. Run the parts in order.\n${text.trim()}\n`;
  writeFileSync(path.join(outDir, `part${i + 1}.sql`), body);
  console.log(`part${i + 1}.sql  ${body.length} chars`);
  if (body.length > 3900) tooLong = true;
});
if (tooLong) {
  console.error("a single statement is longer than 3,900 characters: shorten it before handing it over");
  process.exit(2);
}
