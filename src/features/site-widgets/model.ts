import { z } from "zod";

import { optionalText } from "@/lib/validation";

// SPD-07: a site widget's settings, as the settings form sends them. The database checks the same rules again.

const uuidOrNull = z
  .preprocess((v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null), z.uuid({ error: "הבחירה אינה תקינה." }).nullable());

export const widgetSchema = z.object({
  name: z.string().trim().min(1, "יש לתת שם, למשל שם האתר.").max(80, "עד 80 תווים."),
  button_label: z.string().trim().min(1, "יש לכתוב מה כתוב על הכפתור.").max(40, "עד 40 תווים."),
  show_whatsapp: z.boolean(),
  show_call: z.boolean(),
  show_form: z.boolean(),
  phone: optionalText(40, "מספר הטלפון ארוך מדי.").refine((v) => v === null || /^[0-9+()\- ]+$/.test(v), "מספר טלפון בספרות בלבד."),
  position: z.enum(["left", "right"], { error: "יש לבחור צד." }),
  assign_mode: z.enum(["owner", "round_robin"], { error: "יש לבחור למי הולך ליד חדש." }),
  owner_id: uuidOrNull,
  team_id: uuidOrNull,
  is_active: z.boolean(),
});
export type WidgetInput = z.infer<typeof widgetSchema>;

/** The line the business puts on its website, just before </body>. */
export function embedSnippet(scriptUrl: string): string {
  return `<script src="${scriptUrl}" async></script>`;
}
