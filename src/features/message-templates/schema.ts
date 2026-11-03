import { z } from "zod";

import { MESSAGE_CHANNELS, MESSAGE_TYPES } from "@/features/messaging/providers/types";
import { templateVariantProblem, VARIANT_PROBLEM_MESSAGES } from "@/features/whatsapp/variants";
import { requiredText } from "@/lib/validation";

import { unknownMergeFields } from "./fields";
import { MESSAGE_TEMPLATE_BODY_MAX, MESSAGE_TEMPLATE_NAME_MAX, MESSAGE_TEMPLATE_SUBJECT_MAX, TEMPLATE_LOCALES } from "./templates";

// the name and the subject hold no control character (a line break in a subject could add an email header; the table's
// checks refuse them too, [[:cntrl:]]); the body keeps its line breaks
const CONTROL_CHARACTER = /\p{Cc}/u;
const NO_CONTROL_CHARACTERS = "אפשר לכתוב כאן שורה אחת בלבד, בלי תווים מיוחדים.";

// a textarea sends line breaks as "\r\n"; the database keeps "\n"
const lines = (value: unknown) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value);

/** The same checks the database makes (trigger message_templates_check): gender blocks, then the merge fields. */
export function messageTextProblem(text: string): string | null {
  const problem = templateVariantProblem(text);
  if (problem) return VARIANT_PROBLEM_MESSAGES[problem];
  const unknown = unknownMergeFields(text);
  return unknown.length > 0 ? `השדה ${unknown.join(", ")} לא קיים. אפשר להשתמש רק בשדות שברשימה, כתובים בדיוק כך.` : null;
}

function checkText(text: string, ctx: z.RefinementCtx) {
  const message = messageTextProblem(text);
  if (message) ctx.addIssue({ code: "custom", message });
}

export const messageTemplateSchema = z
  .object({
    name: requiredText(MESSAGE_TEMPLATE_NAME_MAX, "יש להזין שם לתבנית.", `השם ארוך מדי (עד ${MESSAGE_TEMPLATE_NAME_MAX} תווים).`).refine(
      (value) => !CONTROL_CHARACTER.test(value),
      { error: NO_CONTROL_CHARACTERS },
    ),
    channel: z.enum(MESSAGE_CHANNELS, { error: "יש לבחור ערוץ." }),
    message_type: z.enum(MESSAGE_TYPES, { error: "יש לבחור סוג הודעה." }),
    subject: z.preprocess(
      (value) => (typeof value === "string" ? value.trim() : ""),
      z
        .string()
        .max(MESSAGE_TEMPLATE_SUBJECT_MAX, {
          error: `הנושא ארוך מדי (עד ${MESSAGE_TEMPLATE_SUBJECT_MAX} תווים).`,
        })
        .refine((value) => !CONTROL_CHARACTER.test(value), { error: NO_CONTROL_CHARACTERS }),
    ),
    body: z.preprocess(
      lines,
      requiredText(
        MESSAGE_TEMPLATE_BODY_MAX,
        "יש להזין את נוסח ההודעה.",
        `הנוסח ארוך מדי (עד ${MESSAGE_TEMPLATE_BODY_MAX.toLocaleString("he-IL")} תווים).`,
      ).superRefine(checkText),
    ),
    locale: z.enum(TEMPLATE_LOCALES, { error: "יש לבחור שפה." }),
    is_active: z.preprocess((value) => value === "on" || value === "true", z.boolean()),
  })
  .superRefine((value, ctx) => {
    if (value.channel === "email") {
      if (value.subject === "")
        ctx.addIssue({
          code: "custom",
          path: ["subject"],
          message: "לאימייל צריך נושא.",
        });
      else {
        const message = messageTextProblem(value.subject);
        if (message) ctx.addIssue({ code: "custom", path: ["subject"], message });
      }
    }
  })
  .transform((value) => ({
    ...value,
    subject: value.channel === "email" ? value.subject : null,
  }));

export type MessageTemplateInput = z.output<typeof messageTemplateSchema>;
