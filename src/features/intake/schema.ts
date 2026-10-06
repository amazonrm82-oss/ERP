import { z } from "zod";

import { checkbox, optionalId, optionalText, requiredText } from "@/lib/validation";

import { INTAKE_FIELDS } from "./fields";

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

export const updateIntakeSchema = z.object({
  name: requiredText(80, "יש לתת שם.", "השם ארוך מדי (עד 80 תווים)."),
  title: optionalText(120, "הכותרת ארוכה מדי (עד 120 תווים)."),
  intro: optionalText(500, "הטקסט ארוך מדי (עד 500 תווים)."),
  submit_label: optionalText(40, "הטקסט ארוך מדי (עד 40 תווים)."),
  success_message: optionalText(300, "ההודעה ארוכה מדי (עד 300 תווים)."),
  redirect_url: optionalHttpsUrl,
  source_id: optionalId,
  owner_id: optionalId,
  is_active: checkbox,
});

/** show_<field> / required_<field> checkboxes -> forms.fields, in the standard order. */
export function fieldsFromForm(formData: FormData): Array<{ key: string; required: boolean }> {
  return INTAKE_FIELDS.filter((key) => formData.get(`show_${key}`) === "on").map((key) => ({
    key,
    required: formData.get(`required_${key}`) === "on",
  }));
}
