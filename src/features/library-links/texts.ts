// LIB-02: the Hebrew texts of the customer's page and of the card on the record

export const LIBRARY_PAGE_TEXTS = {
  title: "חומר מהעסק",
  openLink: "פתיחת הקישור",
  opensSite: "הקישור פותח את האתר",
  openFile: "פתיחת הקובץ",
} as const;

export const LIBRARY_CARD_TEXTS = {
  title: "חומרים מהספרייה",
  intro: "שולחים ללקוח פריט מספריית התוכן בקישור אישי, ורואים מתי הוא פתח אותו. כשהלקוח פותח את הקישור תקבלו התראה, פעם ביום לכל קישור.",
  noItems: "אין כרגע בספרייה פריטים שאפשר לשלוח (פעילים ובתוקף).",
  toLibrary: "לספריית התוכן",
  pick: "פריט לשליחה",
  create: "יצירת קישור",
  shownOnce: "הקישור מוצג רק עכשיו. שלחו אותו ללקוח: כל מי שיש לו את הקישור יכול לפתוח את הפריט.",
  linkLabel: "הקישור האישי",
  whatsapp: "שליחה ב-WhatsApp",
  email: "שליחה באימייל",
  copy: "העתקת הקישור",
  copied: "הועתק",
  copyFailed: "ההעתקה לא הצליחה. סמנו את הקישור והעתיקו ידנית.",
  done: "סיום",
  sent: "קישורים שנשלחו",
  none: "עוד לא נשלחו קישורים מהספרייה.",
  notOpened: "עוד לא נפתח",
  revoked: "בוטל",
  revoke: "ביטול הקישור",
  revokeTitle: "לבטל את הקישור?",
  revokeText: "הלקוח לא יוכל לפתוח את הפריט מהקישור הזה.",
} as const;

/** "נפתח 3 פעמים, לאחרונה ב-…" / "נפתח פעם אחת ב-…" */
export function viewsText(count: number, lastText: string): string {
  if (count <= 0) return LIBRARY_CARD_TEXTS.notOpened;
  if (count === 1) return `נפתח פעם אחת, ב-${lastText}`;
  return `נפתח ${count} פעמים, לאחרונה ב-${lastText}`;
}
