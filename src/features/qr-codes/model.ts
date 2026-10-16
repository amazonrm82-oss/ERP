import { z } from "zod";

// BIZ-03: what a code opens. Part one: a web form or a booking page of the business.
export type QrTargetKind = "form" | "booking";

/** A target as the picker sends it: "form:<id>" or "booking:<id>". */
export const TARGET_VALUE = /^(form|booking):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function parseTarget(value: string): { kind: QrTargetKind; id: string } | null {
  const match = TARGET_VALUE.exec(value);
  return match ? { kind: match[1] as QrTargetKind, id: match[2] } : null;
}

export const qrCodeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "יש לתת לקוד שם, למשל השלט או הפלייר שהוא מודפס עליו.")
    .max(80, "עד 80 תווים."),
  target: z.string().regex(TARGET_VALUE, "יש לבחור מה הקוד פותח."),
});
