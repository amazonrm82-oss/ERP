import { z } from "zod";

import { BLOCKLIST_CHANNELS, BLOCKLIST_REASONS, BLOCKLIST_REMOVED_REASONS } from "./model";

// CNS-06: the shapes public.consent_blocklist_summary / _find answer (checked before use, FXC-12 style)

export const blocklistSummarySchema = z.object({
  key_present: z.boolean(),
  active: z.number(),
  by_channel: z.record(z.string(), z.number()),
  waiting_hash: z.number(),
  removed: z.number(),
});
export type BlocklistSummary = z.infer<typeof blocklistSummarySchema>;

export const blocklistEntrySchema = z.object({
  id: z.string(),
  channel: z.enum(BLOCKLIST_CHANNELS),
  reason: z.enum(BLOCKLIST_REASONS),
  added_by: z.string().nullable(),
  created_at: z.string(),
  removed_at: z.string().nullable(),
  removed_by: z.string().nullable(),
  removed_reason: z.enum(BLOCKLIST_REMOVED_REASONS).nullable(),
  // CNS-06 answer 4: emptied by a privacy erasure of the person
  note: z.string().nullable(),
});

export const blocklistFindSchema = z.union([
  z.object({ valid: z.literal(false) }),
  z.object({
    valid: z.literal(true),
    kind: z.enum(["phone", "email"]),
    checked: z.boolean(),
    entries: z.array(blocklistEntrySchema),
    erasure: z.boolean(),
  }),
]);

export const blocklistAddResultSchema = z.object({
  added: z.number(),
  existing: z.number(),
  invalid: z.array(z.number()),
});
