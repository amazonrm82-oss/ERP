import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stageSchema } from "@/features/customization/schema";
import { MAX_ROT_DAYS, STAGE_COLOR_VALUES, STAGE_RULE, stageColor, stageTone } from "@/features/deals/stage-colors";

const base = { name: "הצעת מחיר", kind: "open", probability: "50" };

// DEAL-01: a stage's colour and the days a deal may sit in it
describe("stage settings (DEAL-01)", () => {
  it("the palette is the list of the database constraint", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) => readFileSync(join(dir, name), "utf8").includes("stages_color_token"));
    expect(files.length).toBeGreaterThan(0);
    const sql = readFileSync(join(dir, files[files.length - 1]), "utf8");
    const list = /color in \(([^)]*)\)\) not valid/.exec(sql)?.[1] ?? "";
    const keys = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...STAGE_COLOR_VALUES]);
    expect(sql).toContain(`rot_days <= ${MAX_ROT_DAYS}`);
    expect(Object.keys(STAGE_RULE).sort()).toEqual([...STAGE_COLOR_VALUES].sort());
  });

  it("an empty colour means by kind; an unknown one is refused", () => {
    expect(stageSchema.parse({ ...base, color: "", rot_days: "" })).toMatchObject({ color: null, rot_days: null });
    expect(stageSchema.parse({ ...base, color: null, rot_days: null })).toMatchObject({ color: null, rot_days: null });
    expect(stageSchema.parse({ ...base, color: "warning", rot_days: "" }).color).toBe("warning");
    expect(stageSchema.safeParse({ ...base, color: "#ff0000", rot_days: "" }).success).toBe(false);
    expect(stageSchema.safeParse({ ...base, color: "purple", rot_days: "" }).success).toBe(false);
  });

  it("days in stage: empty, or a whole number from 1 to the maximum", () => {
    expect(stageSchema.parse({ ...base, color: "", rot_days: " 7 " }).rot_days).toBe(7);
    expect(stageSchema.parse({ ...base, color: "", rot_days: String(MAX_ROT_DAYS) }).rot_days).toBe(MAX_ROT_DAYS);
    for (const bad of ["0", "-3", "2.5", "abc", String(MAX_ROT_DAYS + 1), "1000"]) {
      const result = stageSchema.safeParse({ ...base, color: "", rot_days: bad });
      expect(result.success, bad).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(["rot_days"]);
        expect(result.error.issues[0].message).toContain("ימים");
      }
    }
  });

  it("a stage shows its own colour, else the colour of its kind", () => {
    expect(stageTone({ kind: "open", color: null })).toBe("accent");
    expect(stageTone({ kind: "won", color: null })).toBe("success");
    expect(stageTone({ kind: "lost", color: null })).toBe("neutral");
    expect(stageTone({ kind: "open", color: "danger" })).toBe("danger");
    expect(stageTone({ kind: "won", color: "#123456" })).toBe("success");
    expect(stageColor("neutral")).toBe("neutral");
    expect(stageColor("bg-red-500")).toBeNull();
  });
});
