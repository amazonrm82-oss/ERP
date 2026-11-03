import { z } from "zod";

import { websiteOk } from "@/features/message-templates/service-rule";
import { createOrganizationSchema } from "@/features/onboarding/schema";
import { checkbox, optionalText, requiredEmail, requiredId, requiredText } from "@/lib/validation";

import { INVITABLE_ROLES, VISIBILITY_OPTIONS } from "./permissions";

export const ORGANIZATION_FIELD_NAMES = ["name", "industry", "team_size", "phone", "website", "record_visibility"] as const;

export const updateOrganizationSchema = createOrganizationSchema.extend({
  // MSG-02 (104): = organizations_website_check / app.message_website_ok (http(s) or a bare host, 300, a domain it can own)
  website: optionalText(300, "הכתובת ארוכה מדי (עד 300 תווים).").refine((value) => value === null || websiteOk(value), {
    error: "זו לא כתובת של אתר העסק. כותבים למשל biz.co.il או https://www.biz.co.il (לא סיומת כללית, אתר משותף, רשת חברתית או קיצור קישורים).",
  }),
  record_visibility: z.enum(
    VISIBILITY_OPTIONS.map((option) => option.value),
    { error: "יש לבחור מי רואה את הרשומות." },
  ),
});

const role = z.enum(INVITABLE_ROLES, { error: "יש לבחור תפקיד." });

export const inviteSchema = z.object({
  email: requiredEmail.transform((value) => value.toLowerCase()),
  role,
});

export const changeRoleSchema = z.object({ role });

export const teamNameSchema = z.object({
  name: requiredText(80, "יש להזין שם לצוות.", "שם הצוות ארוך מדי (עד 80 תווים)."),
});

export const addTeamMemberSchema = z.object({
  user_id: requiredId("יש לבחור משתמש."),
  is_manager: checkbox,
});

export const transferOwnershipSchema = z.object({
  user_id: requiredId("יש לבחור את הבעלים החדש."),
  confirm: checkbox.refine((value) => value, { error: "יש לאשר את העברת הבעלות." }),
});
