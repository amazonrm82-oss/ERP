// GAP-10: the addenda of a quote as the staff list shows them: each version chain once. A version that a sent newer version
// supersedes is left out (the rule of QUO-17's report and of the customer's link); drafts stay.
export function withoutSuperseded<T extends { id: string; previous_id: string | null; sent_at: string | null }>(rows: readonly T[]): T[] {
  const superseded = new Set(rows.filter((r) => r.previous_id && r.sent_at).map((r) => r.previous_id as string));
  return rows.filter((r) => !superseded.has(r.id));
}
