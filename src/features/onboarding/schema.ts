import { z } from "zod";

import { optionalPhone, requiredText } from "@/lib/validation";

import { INDUSTRIES, TEAM_SIZES } from "./options";

const oneOf = (values: readonly string[], message: string) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value : ""),
    z.string().refine((value) => value === "" || values.includes(value), { error: message }),
  );

export const createOrganizationSchema = z.object({
  name: requiredText(120, "יש להזין את שם העסק.", "שם העסק ארוך מדי (עד 120 תווים)."),
  industry: oneOf(
    INDUSTRIES.map((option) => option.value),
    "יש לבחור ענף מהרשימה.",
  ),
  team_size: oneOf(
    TEAM_SIZES.map((option) => option.value),
    "יש לבחור גודל צוות מהרשימה.",
  ),
  phone: optionalPhone,
});
