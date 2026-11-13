import { byGender, withPrefixThe, type OrgTerms } from "@/features/terminology/terms";
import { formatDate, formatMoney } from "@/lib/format";

import { EVENT_LABELS } from "./schema";
import { CYCLE_LABELS, type Cycle } from "./schedule";

// SUB-01: how a billing is described in lists and cards.

/** "₪500 חודשי · לפני מע"מ" */
export function billingAmountText(amountAgorot: number, cycle: Cycle): string {
  return `${formatMoney(amountAgorot)} ${CYCLE_LABELS[cycle]} · לפני מע"מ`;
}

/** The next cycle, the end, or nothing for a stopped billing. */
export function nextCycleText(status: string, nextCycleOn: string | null, endDate: string | null): string {
  if (status === "cancelled") return "בוטל";
  if (status === "paused") return "מושהה: לא נוצרים מחזורים";
  if (status === "failed") return "נכשל: יש לבדוק ולחדש";
  if (nextCycleOn) return `המחזור הבא: ${formatDate(nextCycleOn)}`;
  return endDate ? `הסתיים ב-${formatDate(endDate)}` : "אין מחזור קרוב";
}

/** Owner (354) ב: "5 בחודש", or "היום האחרון בחודש" for 0. */
export function billingDayText(day: number): string {
  return day === 0 ? "היום האחרון בחודש" : `${day} בחודש`;
}

// RVW-94 (FLD-10 on the recurring billing screens): every text that names a deal or a contact, in the business's own words.
// "לקוח" stays: the billing's customer (a contact or a company). Unit tested in tests/unit/rvw94-module-terms.test.ts.

/** SUB-03's "from a won deal" button and its question. */
export function billingFromDealTexts(terms: OrgTerms): { title: string; description: string; button: string } {
  const deal = terms.deal;
  return {
    title: `ליצור חיוב חוזר מ${deal.theSingular}?`,
    description: `השורות החוזרות של ${deal.theSingular} מועתקות לחיוב חוזר חדש של הלקוח, עם המחירים שלהן. בכל מחזור תיווצר משימה להפקת מסמך.`,
    button: `חיוב חוזר מ${deal.theSingular}`,
  };
}

/** The billing page's deal row: its label and its link ("העסקה שממנה נוצר"). */
export function billingDealRow(terms: OrgTerms): { label: string; link: string } {
  const deal = terms.deal;
  return { label: deal.singular, link: `${deal.theSingular} ש${byGender(deal, "ממנו", "ממנה")} נוצר` };
}

/** The billings list's empty state. */
export function billingsEmptyText(terms: OrgTerms): string {
  return `פותחים כרטיס של ${terms.contact.singular} או חברה ולוחצים על "חיוב חוזר חדש".`;
}

/** The history line of each event kind; deal_unlinked names the deal in the business's words. */
export function billingEventLabel(kind: string, terms: OrgTerms): string {
  if (kind === "deal_unlinked") {
    const deal = terms.deal;
    return `הקישור ${withPrefixThe("ל", deal)} הוסר: ${deal.theSingular} ${byGender(deal, "מוזג", "מוזגה")} ל${deal.singular} של לקוח אחר`;
  }
  return EVENT_LABELS[kind] ?? kind;
}
