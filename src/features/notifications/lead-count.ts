// Owner, 13 October 2026 ("ספירת לידים בהודעות"): how a notice counts waiting leads.
// Mirrors app.leads_waiting_text() (migration 0164); a database test compares the two.
export function leadsWaitingText(count: number, businessName: string): string {
  return count === 1
    ? `ליד אחד מחכה לכם ב${businessName}. כדי לראות אותו, חדשו את המנוי.`
    : `${count} לידים מחכים לכם ב${businessName}. כדי לראות אותם, חדשו את המנוי.`;
}
