import { z } from "zod";

import { requiredText } from "@/lib/validation";

import { DEAL_CONTACT_ROLE_NAME_MAX } from "./roles";

// CON-03 follow-up: the name of a role on the business's list
export const dealContactRoleNameSchema = z.object({
  name: requiredText(DEAL_CONTACT_ROLE_NAME_MAX, "יש להזין שם תפקיד.", `שם התפקיד ארוך מדי (עד ${DEAL_CONTACT_ROLE_NAME_MAX} תווים).`),
});
