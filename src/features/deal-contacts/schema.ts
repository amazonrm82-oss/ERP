import { z } from "zod";

import { requiredId } from "@/lib/validation";

import { DEAL_CONTACT_ROLE_KEYS } from "./roles";

/** A role from the list, or "" / nothing for no role (stored as null). */
export const dealContactRoleArg = z
  .union([z.enum(DEAL_CONTACT_ROLE_KEYS), z.literal(""), z.null()])
  .transform((value) => (value ? value : null));

export const DEAL_CONTACT_FIELD_NAMES = ["contact_id", "role"] as const;

export const addDealContactSchema = z.object({
  contact_id: requiredId("יש לבחור איש קשר."),
  role: z.preprocess((value) => (typeof value === "string" ? value : ""), dealContactRoleArg),
});
