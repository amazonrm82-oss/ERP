// PKG-07: shaping the punch cards report (public.report_punch_cards) into the report screen and its export.
// Pure: the report page and the unit tests call it with the parsed result.

import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import type { ReportRow, ReportSection, ReportView } from "./definitions";
import type { ReportData } from "./schemas";

type Allowed = Extract<ReportData<"report_punch_cards">, { allowed: true }>;

const KIND_LABELS: Record<"paid" | "manual" | "unpaid", string> = {
  paid: "שולמה",
  manual: "הופעלה ידנית",
  unpaid: "התשלום הפסיק להיספר",
};

export const PUNCH_PARTIAL_NOTE =
  "דוח חלקי: מוצגות רק הכרטיסיות של אנשי הקשר שיש לך גישה אליהם, ולכן אין סכומי כסף. הדוח המלא זמין למי שרואה את כל אנשי הקשר.";

export const EXPIRED_ROW = "פג תוקף עם יתרה";

export const BINNED_CONTACT = "איש הקשר בסל המחזור";

const day = (value: string) => formatDate(`${value.slice(0, 10)}T12:00:00Z`);
const percent = (ratio: number | null) => (ratio === null ? null : Math.round(ratio * 1000) / 10);

export function punchCardsView(orgId: string, data: Allowed): ReportView {
  const t = data.totals;
  const partial = data.partial;
  const money = (value: number | null) => (value === null ? "—" : formatMoney(value));
  const otherKinds = [
    t.active_manual > 0 ? `${formatNumber(t.active_manual)} הופעלו ידנית` : null,
    t.active_unpaid > 0 ? `${formatNumber(t.active_unpaid)} שהתשלום שלהן הפסיק להיספר` : null,
  ].filter(Boolean);

  const kpis: ReportView["kpis"] = [
    {
      label: "כרטיסיות פעילות",
      value: formatNumber(t.active),
      hint: [`${formatNumber(t.active_paid)} שולמו`, ...otherKinds].join(", "),
    },
    {
      label: "ניצול כניסות",
      value: t.entries_total > 0 ? `${formatNumber(percent(t.entries_used / t.entries_total) ?? 0)}%` : "—",
      hint: `${formatNumber(t.entries_used)} מתוך ${formatNumber(t.entries_total)} כניסות`,
    },
    {
      label: `פגות בתוך ${formatNumber(data.days)} יום`,
      value: formatNumber(t.expiring),
      hint: `${formatNumber(t.expiring_entries)} כניסות שעוד לא נוצלו`,
    },
    {
      label: "כסף על שירות שעוד לא ניתן",
      value: partial ? "—" : money(t.unearned),
      hint: partial ? "דוח חלקי: אין סכומים" : `${formatNumber(t.entries_left)} כניסות שנותרו בכרטיסיות בתוקף`,
    },
  ];

  const sections: ReportSection[] = [
    {
      title: "ניצול לפי מוצר",
      columns: [
        { key: "product", label: "כרטיסייה", kind: "text" },
        { key: "cards", label: "כרטיסיות", kind: "number" },
        { key: "current_cards", label: "בתוקף", kind: "number" },
        { key: "entries_used", label: "כניסות שנוצלו", kind: "number" },
        { key: "entries_total", label: "סך הכניסות", kind: "number" },
        { key: "utilisation", label: "ניצול", kind: "percent" },
        { key: "entries_left", label: "נותרו בתוקף", kind: "number" },
        ...(partial ? [] : [{ key: "unearned", label: "כסף על כניסות שנותרו", kind: "money" as const }]),
      ],
      rows: data.by_product.map(
        (r): ReportRow => ({
          product: r.name ?? "כרטיסייה",
          cards: r.cards,
          current_cards: r.current_cards,
          entries_used: r.entries_used,
          entries_total: r.entries_total,
          utilisation: percent(r.utilisation),
          entries_left: r.entries_left,
          ...(partial ? {} : { unearned: r.unearned }),
        }),
      ),
      bar: "utilisation",
      empty: "אין כרטיסיות פעילות.",
      note: "נספרות כרטיסיות פעילות, בתוקף וגם כאלה שתוקפן עבר. כניסה שהוחזרה לא נספרת כניסה שנוצלה.",
    },
    {
      title: `פגות בתוך ${formatNumber(data.days)} יום`,
      columns: [
        { key: "customer", label: "לקוח", kind: "text" },
        { key: "card", label: "כרטיסייה", kind: "text" },
        { key: "expires_on", label: "יום אחרון לשימוש", kind: "text" },
        { key: "entries_left", label: "כניסות שנותרו", kind: "number" },
        { key: "entries_total", label: "מתוך", kind: "number" },
        { key: "kind", label: "מצב", kind: "text" },
      ],
      rows: data.expiring_cards.map(
        (r): ReportRow => ({
          // a contact in the recycle bin: counted, but not linked
          _href: r.contact_binned ? null : paths.contact(orgId, r.contact_id),
          customer: `${r.contact_name ?? "איש קשר ללא שם"}${r.contact_binned ? ` (${BINNED_CONTACT})` : ""}`,
          card: r.name,
          expires_on: day(r.expires_on),
          entries_left: r.entries_left,
          entries_total: r.entries_total,
          kind: KIND_LABELS[r.kind],
        }),
      ),
      empty: "אין כרטיסיות שעומדות לפוג.",
      note: `כרטיסיות בתוקף עם כניסות שעוד לא נוצלו, שהיום האחרון לשימוש בהן הוא עד ${formatNumber(data.days)} יום מהיום, לפי אזור הזמן של העסק. הקרובות לפוג קודם; עד 200 כרטיסיות, והמספר למעלה כולל את כולן.`,
    },
  ];

  if (!partial) {
    sections.push({
      title: "כסף שהתקבל על שירות שעוד לא ניתן",
      columns: [
        { key: "measure", label: "מה נספר", kind: "text" },
        { key: "cards", label: "כרטיסיות", kind: "number" },
        { key: "amount", label: "סכום", kind: "money" },
      ],
      rows: [
        { measure: "כרטיסיות ששולמו ובתוקף", cards: t.active_paid, amount: t.unearned },
        // owner (116) א: its own row, never inside the service not yet given; paid cards only (the cards its amount sums)
        { measure: EXPIRED_ROW, cards: t.expired_paid_with_entries, amount: t.expired_value },
        { measure: "הופעלו ידנית (בלי תשלום, לא נספר כסף)", cards: t.active_manual, amount: null },
        { measure: "התשלום הפסיק להיספר (לא נספר כסף)", cards: t.active_unpaid, amount: null },
        { measure: "ממתינות לתשלום", cards: t.pending, amount: null },
      ],
      empty: "",
      note: 'לכל כרטיסייה ששולמה: המחיר שלה כפול הכניסות שנותרו חלקי סך הכניסות, מעוגל לאגורה (חצי למעלה) בכל כרטיסייה. המחיר כולל מע"מ, כפי שנשמר כשהכרטיסייה נפתחה. כרטיסייה שתוקפה עבר לא נספרת בשירות שטרם ניתן, כי כבר אי אפשר לנצל אותה: כרטיסיות ששולמו ותוקפן עבר עם כניסות שלא נוצלו מוצגות בשורה "פג תוקף עם יתרה".',
    });
  }

  return { kpis, sections, ...(partial ? { note: PUNCH_PARTIAL_NOTE } : {}) };
}
