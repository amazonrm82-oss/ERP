import { z } from "zod";

// PRV-01: the shapes the retention functions answer (checked before use, FXC-12 style)

export const retentionPreviewSchema = z.object({ months: z.number(), now: z.number(), within_notice: z.number() });
export type RetentionPreview = z.infer<typeof retentionPreviewSchema>;

export const retentionStatusSchema = z.object({
  enabled: z.boolean(),
  months: z.number().nullable(),
  changed_at: z.string().nullable(),
  changed_by: z.string().nullable(),
  open_round: z
    .object({ id: z.string(), months: z.number(), noticed_at: z.string(), due_at: z.string(), total: z.number(), kept: z.number() })
    .nullable(),
  last_round: z.object({ id: z.string(), finished_at: z.string(), binned: z.number() }).nullable(),
});
export type RetentionStatus = z.infer<typeof retentionStatusSchema>;

export const retentionRoundSchema = z.object({
  round: z.object({ id: z.string(), months: z.number(), noticed_at: z.string(), due_at: z.string() }).nullable(),
  leads: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
      created_at: z.string(),
      last_contacted_at: z.string().nullable(),
      kept_at: z.string().nullable(),
      // moved to the bin already by this round (shown without "להשאיר")
      binned: z.boolean(),
      // no longer inactive when the round came due (stays)
      skipped: z.boolean(),
    }),
  ),
  has_more: z.boolean(),
});
export type RetentionRound = z.infer<typeof retentionRoundSchema>;
