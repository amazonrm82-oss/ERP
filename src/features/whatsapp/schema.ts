import { z } from "zod";

import { requiredText } from "@/lib/validation";

import { MESSAGE_MAX, TEMPLATE_BODY_MAX, TEMPLATE_NAME_MAX } from "./templates";

// a textarea sends line breaks as "\r\n"; the database keeps "\n"
const lines = (value: unknown) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value);

export const templateSchema = z.object({
  name: requiredText(TEMPLATE_NAME_MAX, "יש להזין שם לתבנית.", `השם ארוך מדי (עד ${TEMPLATE_NAME_MAX} תווים).`),
  body: z.preprocess(lines, requiredText(TEMPLATE_BODY_MAX, "יש להזין את נוסח ההודעה.", `הנוסח ארוך מדי (עד ${TEMPLATE_BODY_MAX.toLocaleString("he-IL")} תווים).`)),
});

// what the record button sends after it opened WhatsApp: the text as the person left it,
// and the template it started from (null = without a template)
export const sentMessageSchema = z.object({
  text: z.string().max(MESSAGE_MAX * 2).transform((value) => value.replace(/\r\n?/g, "\n").trim()).pipe(z.string().max(MESSAGE_MAX)),
  templateId: z.guid().nullable(),
});
export type SentMessage = z.input<typeof sentMessageSchema>;
