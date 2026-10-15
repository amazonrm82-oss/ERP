import { z } from "zod";

import { CONTACT_LOCALES } from "@/features/contacts/preferences";

import { DISTRIBUTION_METHODS, FIELD_SEPARATOR, TARGET_TEAM, TARGET_USER, WEIGHT_MAX, WEIGHT_MIN } from "./settings";

// A weight field is named "weight:<user id>".
export const WEIGHT_PREFIX = "weight:";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WEIGHT_RANGE = `משקל בין ${WEIGHT_MIN} ל-${WEIGHT_MAX}.`;

export const methodSchema = z.enum(DISTRIBUTION_METHODS, { error: "יש לבחור איך לחלק." });

const weightSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : undefined),
  z.number({ error: "יש לכתוב משקל." }).int({ error: "משקל במספר שלם." }).min(WEIGHT_MIN, { error: WEIGHT_RANGE }).max(WEIGHT_MAX, { error: WEIGHT_RANGE }),
);

export type ParsedDistribution =
  | { ok: true; method: z.infer<typeof methodSchema>; weights: [string, number][] }
  | { ok: false; fieldErrors: Record<string, string> };

/** The method and every "weight:<user id>" field of the form (at most 1,000). */
export function parseDistributionForm(formData: FormData): ParsedDistribution {
  const fieldErrors: Record<string, string> = {};
  const method = methodSchema.safeParse(formData.get("method"));
  if (!method.success) fieldErrors.method = method.error.issues[0]?.message ?? "יש לבחור איך לחלק.";
  const weights: [string, number][] = [];
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith(WEIGHT_PREFIX)) continue;
    const userId = name.slice(WEIGHT_PREFIX.length);
    if (!UUID.test(userId) || weights.length >= 1000) continue;
    const weight = weightSchema.safeParse(value);
    if (weight.success) weights.push([userId, weight.data]);
    else fieldErrors[name] = weight.error.issues[0]?.message ?? WEIGHT_RANGE;
  }
  if (!method.success || Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, method: method.data, weights };
}

const optionalId = z.preprocess((value) => (typeof value === "string" && value !== "" ? value : null), z.string().regex(UUID).nullable());
const optionalLocale = z.preprocess(
  (value) => (typeof value === "string" && value !== "" ? value : null),
  z.enum(CONTACT_LOCALES, { error: "השפה שנבחרה אינה ברשימה." }).nullable(),
);
const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** "<key>|<option>" of the form's list-field choice, or null for none. */
const optionalField = z.preprocess(
  (value) => (typeof value === "string" && value !== "" ? value : null),
  z
    .string()
    .nullable()
    .transform((value, ctx) => {
      if (value === null) return null;
      const at = value.indexOf(FIELD_SEPARATOR);
      const key = at > 0 ? value.slice(0, at) : "";
      const option = at > 0 ? value.slice(at + 1) : "";
      if (!FIELD_KEY.test(key) || option === "" || option.length > 200) {
        ctx.addIssue({ code: "custom", message: "יש לבחור ערך מהרשימה." });
        return z.NEVER;
      }
      return { key, option };
    }),
);

/** "team:<id>" or "user:<id>". */
const target = z
  .string({ error: "יש לבחור לאן הליד הולך." })
  .transform((value, ctx) => {
    const kind = value.startsWith(TARGET_TEAM) ? "team" : value.startsWith(TARGET_USER) ? "user" : null;
    const id = kind ? value.slice((kind === "team" ? TARGET_TEAM : TARGET_USER).length) : "";
    if (!kind || !UUID.test(id)) {
      ctx.addIssue({ code: "custom", message: "יש לבחור לאן הליד הולך." });
      return z.NEVER;
    }
    return { kind, id } as { kind: "team" | "user"; id: string };
  });

/** A new rule: a source, a product, a language and/or a list field, and a team or one person. */
export const ruleSchema = z
  .object({
    source_id: optionalId,
    product_id: optionalId,
    locale: optionalLocale,
    field: optionalField,
    target,
  })
  .refine((rule) => rule.source_id !== null || rule.product_id !== null || rule.locale !== null || rule.field !== null, {
    error: "יש לבחור לפחות תנאי אחד: מקור, מוצר, שפה או שדה.",
    path: ["source_id"],
  })
  .transform((rule) => ({
    source_id: rule.source_id,
    product_id: rule.product_id,
    locale: rule.locale,
    field_key: rule.field?.key ?? null,
    field_value: rule.field?.option ?? null,
    team_id: rule.target.kind === "team" ? rule.target.id : null,
    user_id: rule.target.kind === "user" ? rule.target.id : null,
  }));

export const RULE_FIELD_NAMES = ["source_id", "product_id", "locale", "field", "target"] as const;
