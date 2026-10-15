import { z } from "zod";

import { requiredId } from "@/lib/validation";

/** A role of the organization's list (its id), or "" / nothing for no role (stored as null). The database checks it is an active role of the deal's business. */
export const dealContactRoleArg = z
  .union([z.string().uuid(), z.literal(""), z.null()])
  .transform((value) => (value ? value : null));

export const DEAL_CONTACT_FIELD_NAMES = ["contact_id", "role_id"] as const;

export const addDealContactSchema = z.object({
  contact_id: requiredId("יש לבחור איש קשר."),
  role_id: z.preprocess((value) => (typeof value === "string" ? value : ""), dealContactRoleArg),
});
