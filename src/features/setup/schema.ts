import { z } from "zod";

import { updateOrganizationSchema } from "@/features/settings/schema";

// The same rules as the business details page (/settings/business), split in two:
// step 1 takes the details, step 2 the industry.
export const setupDetailsSchema = updateOrganizationSchema.omit({ industry: true });
export const SETUP_DETAILS_FIELDS = ["name", "team_size", "phone", "record_visibility"] as const;

export const setupIndustrySchema = updateOrganizationSchema.pick({ industry: true });

export const setupStepArg = z.number().int().min(1).max(4);
