import type { BadgeTone } from "@/components/ui/badge";
import type { StageKind } from "@/lib/database.types";

// DEAL-01. A stage's colour is one of the badge tones (as tags, FLD-02), so every colour comes
// from the design system and passes the contrast test in both themes. Stored in stages.color;
// null means "by the stage's kind". The database check `stages_color_token` holds the same list.
export const STAGE_COLORS = [
  { value: "accent", label: "כחול" },
  { value: "success", label: "ירוק" },
  { value: "warning", label: "כתום" },
  { value: "danger", label: "אדום" },
  { value: "neutral", label: "אפור" },
] as const;
export type StageColor = (typeof STAGE_COLORS)[number]["value"] & BadgeTone;
export const STAGE_COLOR_VALUES = STAGE_COLORS.map((c) => c.value) as [StageColor, ...StageColor[]];

const KIND_TONE: Record<StageKind, StageColor> = { open: "accent", won: "success", lost: "neutral" };

/** The stored colour when it is a known one, else null (shown by kind). */
export function stageColor(color: string | null | undefined): StageColor | null {
  return STAGE_COLOR_VALUES.includes(color as StageColor) ? (color as StageColor) : null;
}

/** The tone a stage is shown in: its own colour, or the colour of its kind. */
export function stageTone(stage: { kind: StageKind; color?: string | null }): StageColor {
  return stageColor(stage.color) ?? KIND_TONE[stage.kind];
}

// The coloured rule on top of a board column. Full class names, so Tailwind sees them.
export const STAGE_RULE: Record<StageColor, string> = {
  accent: "border-t-accent",
  success: "border-t-success",
  warning: "border-t-warning",
  danger: "border-t-danger",
  neutral: "border-t-line-strong",
};

/** Days a deal may sit in a stage before it counts as stuck, when the stage sets none (spec 22.9). */
export const DEFAULT_ROT_DAYS = 14;
export const MAX_ROT_DAYS = 365;
