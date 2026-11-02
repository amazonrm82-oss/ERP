import { z } from "zod";

import { DORMANT_MAX, DORMANT_MIN, FORMER_MAX, FORMER_MIN } from "./status";

export const CUSTOMER_STATUS_FIELD_NAMES = ["dormant_months", "former_months"] as const;

const wholeNumber = (missing: string, min: number, max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : undefined),
    z
      .number({ error: missing })
      .int({ error: "מספר שלם של חודשים." })
      .min(min, { error: `בין ${min} ל-${max} חודשים.` })
      .max(max, { error: `בין ${min} ל-${max} חודשים.` }),
  );

/** CON-11: the two thresholds, whole months in the table's ranges, and "former" after "dormant". */
export const customerStatusSettingsSchema = z
  .object({
    dormant_months: wholeNumber("יש לכתוב אחרי כמה חודשים לקוח נחשב רדום.", DORMANT_MIN, DORMANT_MAX),
    former_months: wholeNumber("יש לכתוב אחרי כמה חודשים לקוח נחשב לשעבר.", FORMER_MIN, FORMER_MAX),
  })
  .refine((v) => v.former_months > v.dormant_months, { path: ["former_months"], error: "צריך להיות יותר מהחודשים עד לקוח רדום." });

export type CustomerStatusSettingsInput = z.infer<typeof customerStatusSettingsSchema>;
