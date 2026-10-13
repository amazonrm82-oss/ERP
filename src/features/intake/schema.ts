import { z } from "zod";

import { checkbox, optionalId, optionalText, requiredText } from "@/lib/validation";

import {
  FORM_EXCLUDED_TYPES,
  isFormFieldKey,
  MAX_FORM_FIELDS,
  MAX_HELP_LENGTH,
  MAX_SHOW_VALUE_LENGTH,
  type FormFieldConfig,
  type FormFieldOption,
  type ShowIf,
} from "./fields";
import { MAX_WHATSAPP_TEXT, whatsappNumber } from "./whatsapp";

export const createIntakeSchema = z.object({
  name: requiredText(80, "יש לתת שם.", "השם ארוך מדי (עד 80 תווים)."),
  kind: z.enum(["form", "webhook"]),
});

const optionalHttpsUrl = optionalText(500, "הכתובת ארוכה מדי.").refine(
  (value) => {
    if (value === null) return true;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  },
  { error: "יש להזין כתובת מלאה שמתחילה ב-https://" },
);

// CAP-05: a number WhatsApp can open, as typed; empty = the business phone
const optionalWhatsappPhone = optionalText(30, "המספר ארוך מדי.").refine(
  (value) => value === null || (/^[0-9+() -]+$/.test(value) && whatsappNumber(value) !== null),
  { error: "יש להזין מספר טלפון תקין, למשל 050-1234567." },
);

export const updateIntakeSchema = z.object({
  name: requiredText(80, "יש לתת שם.", "השם ארוך מדי (עד 80 תווים)."),
  title: optionalText(120, "הכותרת ארוכה מדי (עד 120 תווים)."),
  intro: optionalText(500, "הטקסט ארוך מדי (עד 500 תווים)."),
  submit_label: optionalText(40, "הטקסט ארוך מדי (עד 40 תווים)."),
  success_message: optionalText(300, "ההודעה ארוכה מדי (עד 300 תווים)."),
  redirect_url: optionalHttpsUrl,
  source_id: optionalId,
  owner_id: optionalId,
  team_id: optionalId,
  assign_mode: z.enum(["owner", "round_robin"], { error: "יש לבחור איך מחלקים את הלידים." }),
  is_active: checkbox,
  whatsapp_button: checkbox,
  whatsapp_phone: optionalWhatsappPhone,
  whatsapp_text: optionalText(MAX_WHATSAPP_TEXT, `ההודעה ארוכה מדי (עד ${MAX_WHATSAPP_TEXT} תווים).`),
});

const fieldsJsonSchema = z
  .array(
    z.object({
      key: z.string().max(60),
      required: z.boolean(),
      help: z.string().max(MAX_HELP_LENGTH * 2).nullish(),
      showIf: z.object({ field: z.string().max(60), value: z.string().max(MAX_SHOW_VALUE_LENGTH * 2).nullable() }).nullish(),
    }),
  )
  .max(MAX_FORM_FIELDS);

/**
 * The fields of the form builder (hidden input fields_json), checked against
 * the business's lead fields (CAP-01). Returns the fields to store, or a
 * Hebrew message.
 */
export function fieldsFromForm(formData: FormData, available: FormFieldOption[]): { ok: true; fields: FormFieldConfig[] } | { ok: false; message: string } {
  const raw = formData.get("fields_json");
  let json: unknown;
  try {
    json = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  const parsed = fieldsJsonSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, message: `רשימת השדות אינה תקינה (עד ${MAX_FORM_FIELDS} שדות, טקסט עזרה עד ${MAX_HELP_LENGTH} תווים).` };
  }
  return checkFormFields(parsed.data, available);
}

export function checkFormFields(
  input: Array<{ key: string; required: boolean; help?: string | null; showIf?: { field: string; value: string | null } | null }>,
  available: FormFieldOption[],
): { ok: true; fields: FormFieldConfig[] } | { ok: false; message: string } {
  const byKey = new Map(available.map((option) => [option.key, option]));
  const fields: FormFieldConfig[] = [];
  for (const item of input) {
    const option = byKey.get(item.key);
    if (!option || !isFormFieldKey(item.key) || (option.type && FORM_EXCLUDED_TYPES.includes(option.type))) {
      return { ok: false, message: "אחד השדות כבר לא קיים. רעננו את הדף ונסו שוב." };
    }
    if (fields.some((field) => field.key === item.key)) {
      return { ok: false, message: `השדה "${option.label}" מופיע פעמיים.` };
    }
    const help = item.help?.trim() || null;
    if (help && help.length > MAX_HELP_LENGTH) {
      return { ok: false, message: `טקסט העזרה של "${option.label}" ארוך מדי (עד ${MAX_HELP_LENGTH} תווים).` };
    }
    let showIf: ShowIf | null = null;
    if (item.showIf) {
      const controller = byKey.get(item.showIf.field);
      if (!controller || !fields.some((field) => field.key === item.showIf?.field)) {
        return { ok: false, message: `"${option.label}" יכול להיות תלוי רק בשדה שמופיע לפניו.` };
      }
      const value = item.showIf.value?.trim() || null;
      if (value !== null && !((controller.type === "select" || controller.type === "multi_select") && controller.options.includes(value))) {
        return { ok: false, message: `התנאי של "${option.label}" צריך להיות אחת האפשרויות של "${controller.label}".` };
      }
      showIf = { field: item.showIf.field, value };
    }
    fields.push({ key: item.key, required: item.required, help, showIf });
  }
  // a lead needs a way back to the person, on every filled form
  if (!fields.some((field) => ["full_name", "phone", "email"].includes(field.key) && !field.showIf)) {
    return { ok: false, message: "הטופס צריך לבקש תמיד לפחות אחד: שם, טלפון או אימייל (בלי תנאי)." };
  }
  return { ok: true, fields };
}
