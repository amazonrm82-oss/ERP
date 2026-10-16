import type { BadgeTone } from "@/components/ui/badge";
import type { Json } from "@/lib/database.types";

import type { FieldDefinition } from "./types";

// FLD-06: the colour of a status option is one of the badge tones, so every colour comes from the design
// system and passes the contrast test in both themes (as stages, DEAL-01). Stored in
// field_definitions.option_colors as {option: key}; the database check app.field_option_colors_ok() holds the
// same list. An option without a colour shows neutral.
export const STATUS_COLORS = [
  { value: "neutral", label: "אפור" },
  { value: "accent", label: "כחול" },
  { value: "success", label: "ירוק" },
  { value: "warning", label: "כתום" },
  { value: "danger", label: "אדום" },
] as const;
export type StatusColor = (typeof STATUS_COLORS)[number]["value"] & BadgeTone;
export const STATUS_COLOR_VALUES = STATUS_COLORS.map((c) => c.value) as [StatusColor, ...StatusColor[]];

export function isStatusColor(value: unknown): value is StatusColor {
  return typeof value === "string" && (STATUS_COLOR_VALUES as readonly string[]).includes(value);
}

/** The stored colours as read from the database: known keys of known options only. */
export function parseOptionColors(raw: Json | null | undefined, options: string[]): Record<string, StatusColor> {
  const colors: Record<string, StatusColor> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return colors;
  for (const [option, color] of Object.entries(raw)) {
    if (options.includes(option) && isStatusColor(color)) colors[option] = color;
  }
  return colors;
}

/** The colours to store with these options: each kept option's colour, nothing for a removed one, never neutral. */
export function colorsForOptions(colors: Record<string, string>, options: string[]): Record<string, StatusColor> {
  const kept: Record<string, StatusColor> = {};
  for (const option of options) {
    const color = colors[option];
    if (isStatusColor(color) && color !== "neutral") kept[option] = color;
  }
  return kept;
}

/** The tone a status value is shown in. */
export function statusTone(field: Pick<FieldDefinition, "optionColors">, value: string): StatusColor {
  const color = field.optionColors?.[value];
  return isStatusColor(color) ? color : "neutral";
}
