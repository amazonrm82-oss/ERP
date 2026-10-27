import { z } from "zod";

// BIZ-03: what a code opens: a web form, a booking page or a rep's business card of the business, or any https link
// (owner, 18 October 2026).
export type QrTargetKind = "form" | "booking" | "card" | "url";

export const QR_TARGET_KINDS: readonly QrTargetKind[] = ["form", "booking", "card", "url"];

export const QR_KIND_LABELS: Record<QrTargetKind, string> = {
  form: "טופס",
  booking: "דף קביעת תור",
  card: "כרטיס ביקור",
  url: "קישור",
};

/** A target of the business as the picker sends it: "form:<id>", "booking:<id>" or "card:<id>". */
export const TARGET_VALUE = /^(form|booking|card):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function parseTarget(value: string): { kind: Exclude<QrTargetKind, "url">; id: string } | null {
  const match = TARGET_VALUE.exec(value);
  return match ? { kind: match[1] as Exclude<QrTargetKind, "url">, id: match[2] } : null;
}

export const qrCodeSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "יש לתת לקוד שם, למשל השלט או הפלייר שהוא מודפס עליו.")
      .max(80, "עד 80 תווים."),
    kind: z.enum(["form", "booking", "card", "url"], { error: "יש לבחור מה הקוד פותח." }),
    target: z.string().nullish(),
    url: z.string().max(4000, "הקישור ארוך מדי (עד 2,000 תווים).").nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "url") return;
    const target = parseTarget(value.target ?? "");
    if (!target || target.kind !== value.kind) ctx.addIssue({ code: "custom", path: ["target"], message: "יש לבחור מה הקוד פותח." });
  });

/** The columns a new code is written with: exactly one target column, by its kind. */
export function targetColumns(kind: QrTargetKind, id: string | null, url: string | null) {
  return {
    target_kind: kind,
    form_id: kind === "form" ? id : null,
    booking_page_id: kind === "booking" ? id : null,
    business_card_id: kind === "card" ? id : null,
    target_url: kind === "url" ? url : null,
  };
}
