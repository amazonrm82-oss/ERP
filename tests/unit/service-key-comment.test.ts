import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// RVW-59 (third time after RVW-29 and RVW-48): the comment on the service-role client and .env.example fell behind the
// eslint allow-list. Every file the list lets import the service client must be named in the comment.
const root = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function allowList(): string[] {
  const config = read("eslint.config.mjs");
  const start = config.indexOf("FXC-08: the service-role key");
  expect(start, "the FXC-08 block of eslint.config.mjs").toBeGreaterThan(-1);
  const open = config.indexOf("ignores: [", start);
  const close = config.indexOf("],", open);
  expect(open).toBeGreaterThan(start);
  const block = config.slice(open, close).replace(/\/\/.*$/gm, "");
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("service-role key: the comment lists the eslint allow-list (RVW-59)", () => {
  it("reads a non-trivial allow-list", () => {
    const files = allowList();
    expect(files).toContain("src/lib/supabase/service.ts");
    expect(files).toContain("src/features/quotes/pdf-store-server.ts");
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it("names every allowed file in src/lib/supabase/service.ts", () => {
    const comment = read("src/lib/supabase/service.ts");
    const missing = allowList()
      .filter((path) => path !== "src/lib/supabase/service.ts")
      .filter((path) => !comment.includes(path));
    expect(missing).toEqual([]);
  });

  it("names the one use inside a signed-in user's request, in both texts", () => {
    expect(read("src/lib/supabase/service.ts")).toMatch(/QUO-06/);
    expect(read(".env.example")).toMatch(/QUO-06/);
    expect(read(".env.example")).toContain("/api/forms/quote/<token>/pdf");
    expect(read(".env.example")).toContain("/legal/subprocessors");
  });
});
