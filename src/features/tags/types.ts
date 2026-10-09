export const TAGGABLE = ["lead", "contact", "company", "deal"] as const;
export type Taggable = (typeof TAGGABLE)[number];

// A tag's colour is one of the badge tones, so every colour comes from the design
// system and passes the contrast test in both themes (FLD-02). Stored in tags.color.
export const TAG_COLORS = [
  { value: "accent", label: "כחול" },
  { value: "success", label: "ירוק" },
  { value: "warning", label: "כתום" },
  { value: "danger", label: "אדום" },
  { value: "neutral", label: "אפור" },
] as const;
export type TagColor = (typeof TAG_COLORS)[number]["value"];
export const TAG_COLOR_VALUES = TAG_COLORS.map((c) => c.value) as [TagColor, ...TagColor[]];

/** The badge tone of a stored colour; a tag without one is blue. */
export function tagTone(color: string | null | undefined): TagColor {
  return TAG_COLOR_VALUES.includes(color as TagColor) ? (color as TagColor) : "accent";
}
