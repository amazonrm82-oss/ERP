import { describe, expect, it } from "vitest";

import { colorsForOptions, isStatusColor, parseOptionColors, STATUS_COLOR_VALUES, statusTone } from "@/features/custom-fields/status-colors";
import type { FieldDefinition, FieldType } from "@/features/custom-fields/types";
import { displayCustomFields, durationInput, formatDuration, inputValue, parseCustomFields, parseDuration } from "@/features/custom-fields/values";
import { STAGE_COLOR_VALUES } from "@/features/deals/stage-colors";

const field = (type: FieldType, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  id: "f",
  key: "f",
  label: "שדה",
  type,
  options: [],
  isRequired: false,
  isActive: true,
  helpText: null,
  ...extra,
});
const parse = (definition: FieldDefinition, input: string) => {
  const form = new FormData();
  form.set("cf_f", input);
  return parseCustomFields([definition], form);
};

// FLD-06 part A: rich text, duration and coloured status.
describe("duration", () => {
  it("reads minutes or hours:minutes, up to a year", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration(" 0 ")).toBe(0);
    expect(parseDuration("8760:00")).toBe(525_600);
    for (const bad of ["8760:01", "525601", "1:60", "1.5", "-5", "שעה", "", "1:5"]) expect(parseDuration(bad), bad).toBeNull();
  });

  it("shows hours and minutes in words, and back in the input as typed", () => {
    expect(formatDuration(0)).toBe("0 דקות");
    expect(formatDuration(1)).toBe("דקה");
    expect(formatDuration(45)).toBe("45 דקות");
    expect(formatDuration(60)).toBe("שעה");
    expect(formatDuration(120)).toBe("שעתיים");
    expect(formatDuration(135)).toBe("שעתיים ו-15 דקות");
    expect(formatDuration(61)).toBe("שעה ו-דקה");
    expect(formatDuration(300)).toBe("5 שעות");
    expect(durationInput(45)).toBe("45");
    expect(durationInput(90)).toBe("1:30");
    expect(durationInput(605)).toBe("10:05");
    for (const minutes of [0, 7, 59, 60, 61, 1439, 525_600]) expect(parseDuration(durationInput(minutes)), String(minutes)).toBe(minutes);
  });

  it("a record form stores minutes and refuses anything else", () => {
    expect(parse(field("duration"), "2:15").values.f).toBe(135);
    expect(parse(field("duration"), "1.5").errors.cf_f).toContain("1:30");
    expect(inputValue(field("duration"), { f: 135 })).toBe("2:15");
    expect(displayCustomFields([field("duration")], { f: 135 })[0].text).toBe("שעתיים ו-15 דקות");
  });
});

describe("rich text", () => {
  it("is stored as cleaned Markdown: marks kept, unsafe links reduced to their words", () => {
    const { values } = parse(field("rich_text"), "**חשוב**\n- [אתר](https://example.com)\n- [רע](javascript:void)");
    expect(values.f).toBe("**חשוב**\n- [אתר](https://example.com)\n- רע");
    expect(parse(field("rich_text"), "x".repeat(5001)).errors.cf_f).toBeTruthy();
  });

  it("lists and exports get the words; the card gets the Markdown to render (never HTML)", () => {
    const [shown] = displayCustomFields([field("rich_text")], { f: "**חשוב** מאוד\n- אחד" });
    expect(shown.text).toBe("חשוב מאוד אחד");
    expect(shown.markdown).toBe("**חשוב** מאוד\n- אחד");
    expect(displayCustomFields([field("rich_text")], { f: "" })[0].markdown ?? null).toBeNull();
    expect(displayCustomFields([field("text")], { f: "**x**" })[0].markdown ?? null).toBeNull();
  });
});

describe("coloured status", () => {
  const status = field("status", { options: ["חדש", "סגור"], optionColors: { סגור: "success" } });

  it("takes one of the options", () => {
    expect(parse(status, "סגור").values.f).toBe("סגור");
    expect(parse(status, "אחר").errors.cf_f).toBeTruthy();
  });

  it("shows the option's palette tone, neutral when it has none or the value left the list", () => {
    expect(displayCustomFields([status], { f: "סגור" })[0]).toMatchObject({ text: "סגור", tone: "success" });
    expect(displayCustomFields([status], { f: "חדש" })[0].tone).toBe("neutral");
    expect(statusTone(status, "ישן")).toBe("neutral");
    expect(displayCustomFields([field("select", { options: ["א"] })], { f: "א" })[0].tone ?? null).toBeNull();
  });

  it("colours are palette keys only, the same as stages; stored ones are cleaned when read and when saved", () => {
    expect([...STATUS_COLOR_VALUES].sort()).toEqual([...STAGE_COLOR_VALUES].sort());
    expect(isStatusColor("#ff0000")).toBe(false);
    expect(parseOptionColors({ א: "danger", ב: "purple", ג: "accent" }, ["א", "ב"])).toEqual({ א: "danger" });
    expect(parseOptionColors(["accent"], ["א"])).toEqual({});
    // a removed option's colour goes; neutral is not stored
    expect(colorsForOptions({ א: "danger", ב: "neutral", ג: "accent" }, ["א", "ב"])).toEqual({ א: "danger" });
  });

  it("the palette in the migration equals the app's", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((name) => name.endsWith("_field_types_part_a.sql")) as string;
    const sql = readFileSync(join(dir, file), "utf8");
    const list = sql.slice(sql.indexOf("not in ('accent'"));
    const keys = [...list.slice(0, list.indexOf(")")).matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...STATUS_COLOR_VALUES].sort());
  });
});
