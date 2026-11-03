import type { FieldObject } from "@/features/custom-fields/types";

// PRK-01: the built-in fields that hold personal information, per record type, for the privacy center. A fixed list in
// code (the database keeps no mark on built-in columns). A new built-in column that holds personal information is
// added here. The list describes what the system keeps; it is not legal advice.

export type BuiltInPersonalField = { label: string; note?: string };

export const BUILT_IN_PERSONAL_FIELDS: Record<FieldObject, readonly BuiltInPersonalField[]> = {
  lead: [
    { label: "שם מלא" },
    { label: "טלפון ואימייל" },
    { label: "תפקיד ושם החברה" },
    { label: "מגדר, שפה מועדפת וערוץ מועדף" },
    { label: "ההודעה מהטופס" },
    { label: "מקור ההגעה", note: "קמפיין, דף הנחיתה, האתר המפנה ומזהי קליק של הפרסום" },
  ],
  contact: [
    { label: "שם פרטי ושם משפחה" },
    { label: "טלפונים ואימיילים", note: "גם הנוספים" },
    { label: "כתובת ועיר" },
    { label: "תאריך לידה" },
    { label: "מגדר, שפה מועדפת וערוץ מועדף" },
    { label: "תפקיד" },
    { label: "פרטי חיוב", note: "שם לחשבונית, תעודת זהות או מספר עוסק, כתובות ואימייל לחשבונית" },
    { label: "מקור ההגעה", note: "קמפיין ופרמטרי פרסום" },
  ],
  company: [
    { label: "טלפון, אימייל ואתר", note: "מידע אישי כשהחברה היא עוסק יחיד" },
    { label: "כתובת ופרטי חיוב", note: "מידע אישי כשהחברה היא עוסק יחיד" },
    { label: "מספר עוסק או ח.פ.", note: "מידע אישי כשהחברה היא עוסק יחיד" },
  ],
  deal: [{ label: "שם העסקה", note: "כשהוא כולל את שם הלקוח" }],
};

/** What the system keeps about people beside the record fields. */
export const OTHER_PERSONAL_DATA: readonly BuiltInPersonalField[] = [
  { label: "תיעוד, הערות ופגישות", note: "מה שהצוות כותב על האדם" },
  { label: "קבצים מצורפים" },
  { label: "פניות מטפסים", note: "תוכן הפנייה. טביעה מגובבת של כתובת ה-IP נשמרת עד 15 דקות להגבלת קצב" },
  { label: "הסכמות לדיוור והסרות", note: "רשימת החסימה שומרת טביעה מגובבת בלבד, לא את הכתובת" },
  { label: "חתימה על הצעת מחיר", note: "שם, תעודת זהות אם נמסרה, החתימה, כתובת IP ודפדפן" },
  { label: "תשלומים, צ'קים ומסמכים", note: "סכומים, אמצעי תשלום ומספרי צ'ק" },
  { label: "יומן הביקורת", note: "מי שינה מה. במחיקת פרטיות תוכן הרשומות נמחק" },
];
