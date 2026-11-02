// USR-12: the "what's new" list, newest first. Written by hand, in Hebrew, for the people who use the system (not
// developers): what changed and where to find it. A new entry goes at the top with its date; the unread dot in the
// account menu shows until the person opens the page (profiles.whats_new_seen_on).

export type WhatsNewEntry = {
  // YYYY-MM-DD, the day it reached the system
  date: string;
  title: string;
  body: string;
};

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    date: "2026-11-02",
    title: "פנייה לתמיכה מתוך המערכת",
    body: "בתפריט החשבון יש עכשיו \"פנייה לתמיכה\": כותבים מה קרה, ואפשר לצרף את הדף שהייתם בו. רואים שם את הפניות ששלחתם ואת המצב שלהן, ומקבלים התראה כשיש תשובה.",
  },
  {
    date: "2026-11-01",
    title: "קבצי PDF להזמנות, לדף החשבון ולדוחות",
    body: "להזמנה יש עכשיו PDF שהלקוח מוריד מהקישור שלו; דף החשבון של הלקוח ודוחות יוצאים גם כ-PDF, מהמסך של כל אחד.",
  },
  {
    date: "2026-11-01",
    title: "הצעת מחיר חתומה",
    body: "כשלקוח מאשר הצעת מחיר בקישור, נשמר עותק PDF חתום עם השם והחתימה שלו. זמין לבעלים ולמנהלי מערכת בכרטיס ההצעה.",
  },
  {
    date: "2026-10-29",
    title: "יעד גבייה ודוח גבייה",
    body: "אפשר לקבוע יעד גבייה לחודש, לרבעון או לשנה, ולראות בדוח הגבייה כמה נגבה, באילו אמצעים, ותוך כמה ימים לקוחות משלמים.",
  },
  {
    date: "2026-10-28",
    title: "מסך גבייה והבטחות תשלום",
    body: "מסך אחד לכל החובות הפתוחים לפי גיל החוב, עם הבטחות תשלום של לקוחות ותזכורות שנוצרות לבד לפני מועד התשלום ואחריו.",
  },
];

/** The newest entry's date (the list is kept newest first). */
export const LATEST_WHATS_NEW = WHATS_NEW.reduce((latest, entry) => (entry.date > latest ? entry.date : latest), "");

/** Is there an entry newer than what the person saw? Never opened = yes. */
export function hasUnreadWhatsNew(seenOn: string | null): boolean {
  return LATEST_WHATS_NEW !== "" && (seenOn === null || seenOn < LATEST_WHATS_NEW);
}
