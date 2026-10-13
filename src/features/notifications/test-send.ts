import { z } from "zod";

// GAP-01: what public.send_test_notification() answers, and the words for it.

export const TEST_PER_WINDOW = 3;
export const TEST_WINDOW_MINUTES = 10;

const resultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.literal("rate"), retry_seconds: z.number().int().positive() }),
]);

export type TestSendResult = z.infer<typeof resultSchema>;

/** The function's answer, or null when it has an unexpected shape. */
export function parseTestSendResult(value: unknown): TestSendResult | null {
  const parsed = resultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const TEST_SENT_MESSAGE =
  "נשלחה התראת בדיקה. היא תופיע בפעמון, ובתוך דקה גם בכל מכשיר שבו ההתראות פעילות. לא הגיעה לטלפון? בדקו שההתראות מופעלות בו.";

/** "Wait" message after the limit, rounded up to whole minutes. */
export function testRateMessage(retrySeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retrySeconds / 60));
  const wait = minutes === 1 ? "בעוד דקה" : `בעוד ${minutes} דקות`;
  return `אפשר לשלוח עד ${TEST_PER_WINDOW} התראות בדיקה ב-${TEST_WINDOW_MINUTES} דקות. נסו שוב ${wait}.`;
}
