import { z } from "zod";

import { sanitizeNote } from "@/features/activities/markdown";
import { mentionIds } from "@/features/mentions/token";
import { templateVariantProblem, VARIANT_PROBLEM_MESSAGES } from "@/features/whatsapp/variants";
import { requiredText } from "@/lib/validation";

import { DOCUMENT_RECORD_TYPES, unknownDocumentFields, type DocumentRecordType } from "./fields";
import { DOCUMENT_KINDS, DOCUMENT_TEMPLATE_BODY_MAX, DOCUMENT_TEMPLATE_NAME_MAX } from "./templates";

const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * The body as stored: REC-04's cleaned Markdown (control characters and bidi overrides removed, a link to a forbidden
 * address reduced to its words, line ends unified), trimmed.
 */
export function cleanDocumentBody(value: string): string {
  return sanitizeNote(value).trim();
}

/** The same checks the database makes (trigger document_templates_check), plus no mention of a colleague. */
export function documentBodyProblem(body: string, type: DocumentRecordType): string | null {
  const problem = templateVariantProblem(body);
  if (problem) return VARIANT_PROBLEM_MESSAGES[problem];
  const unknown = unknownDocumentFields(body, type);
  if (unknown.length > 0) return `השדה ${unknown.join(", ")} לא קיים לסוג הרשומה הזה. אפשר להשתמש רק בשדות שברשימה, כתובים בדיוק כך.`;
  if (mentionIds(body).length > 0) return "אי אפשר לתייג אנשי צוות במסמך.";
  return null;
}

export const documentTemplateSchema = z
  .object({
    name: requiredText(DOCUMENT_TEMPLATE_NAME_MAX, "יש להזין שם לתבנית.", `השם ארוך מדי (עד ${DOCUMENT_TEMPLATE_NAME_MAX} תווים).`).refine(
      (value) => !CONTROL_CHARACTER.test(value),
      { error: "אפשר לכתוב כאן שורה אחת בלבד, בלי תווים מיוחדים." },
    ),
    kind: z.enum(DOCUMENT_KINDS, { error: "יש לבחור סוג מסמך." }),
    record_type: z.enum(DOCUMENT_RECORD_TYPES, { error: "יש לבחור מאיזו רשומה המסמך מתמלא." }),
    body: z.preprocess(
      (value) => (typeof value === "string" ? cleanDocumentBody(value) : value),
      requiredText(
        DOCUMENT_TEMPLATE_BODY_MAX,
        "יש להזין את נוסח המסמך.",
        `הנוסח ארוך מדי (עד ${DOCUMENT_TEMPLATE_BODY_MAX.toLocaleString("he-IL")} תווים).`,
      ),
    ),
    is_active: z.preprocess((value) => value === "on" || value === "true", z.boolean()),
  })
  .superRefine((value, ctx) => {
    const message = documentBodyProblem(value.body, value.record_type);
    if (message) ctx.addIssue({ code: "custom", path: ["body"], message });
  });

export type DocumentTemplateInput = z.output<typeof documentTemplateSchema>;
