import type { ComponentType, SVGProps } from "react";

import {
  BellIcon,
  BoardIcon,
  BoltIcon,
  ChartIcon,
  ChatIcon,
  CheckSquareIcon,
  FormIcon,
  InboxIcon,
  LockIcon,
  SearchIcon,
  UploadIcon,
  UsersIcon,
} from "@/components/ui/icons";

export type FeatureStatus = "live" | "soon";

export type Feature = {
  key: string;
  title: string;
  text: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  status: FeatureStatus;
};

/**
 * Everything the landing page says the system does (LND-03, LND-04). A part
 * is "live" only when it works in the product today; whatever is not built yet
 * is "soon" and is shown apart, never as a promise. A new part that is built is
 * moved to "live" in the same change.
 */
export const FEATURES: Feature[] = [
  { key: "leads", status: "live", icon: InboxIcon, title: "לידים", text: "כל פנייה נכנסת לרשימה אחת, עם מקור, סטטוס ואחראי, ובטלפון חיוג ו-WhatsApp בלחיצה." },
  { key: "contacts", status: "live", icon: UsersIcon, title: "אנשי קשר וחברות", text: "ליד מתאים הופך לאיש קשר ולחברה, וכל ההיסטוריה עוברת איתו." },
  { key: "deals", status: "live", icon: BoardIcon, title: "עסקאות ותהליך מכירה", text: "לוח עם שלבי המכירה שלכם, וסכום פתוח בכל שלב. גוררים עסקה לשלב הבא." },
  { key: "tasks", status: "live", icon: CheckSquareIcon, title: "משימות ותזכורות", text: "\"היום שלי\" מראה לכל אחד בצוות מה מחכה לו היום ומה באיחור." },
  { key: "forms", status: "live", icon: FormIcon, title: "טפסים לקליטת לידים", text: "טופס לאתר או קישור לשיתוף. כל פנייה נכנסת כליד ומחולקת לצוות." },
  { key: "automations", status: "live", icon: BoltIcon, title: "אוטומציות", text: "משימה, התראה או שינוי סטטוס שקורים לבד, מתבניות מוכנות." },
  { key: "reports", status: "live", icon: ChartIcon, title: "דוחות", text: "מקורות לידים, ביצועי הצוות ותהליך המכירה, עם ייצוא לאקסל." },
  { key: "import", status: "live", icon: UploadIcon, title: "ייבוא מאקסל", text: "מעלים קובץ Excel או CSV, ממפים עמודות, ומדלגים על כפולים. אפשר לבטל ייבוא." },
  { key: "files", status: "live", icon: FormIcon, title: "קבצים", text: "הצעות מחיר, תמונות ומסמכים על כל רשומה, במקום אחד." },
  { key: "search", status: "live", icon: SearchIcon, title: "חיפוש", text: "חיפוש אחד על כל המערכת, שמבין גם שגיאות כתיב בעברית." },
  { key: "mobile", status: "live", icon: BellIcon, title: "אפליקציה לטלפון עם התראות", text: "מתקינים מהדפדפן למסך הבית, ומקבלים התראה על ליד חדש ועל תזכורת." },
  { key: "teams", status: "live", icon: UsersIcon, title: "צוותים והרשאות", text: "כל אחד רואה את מה שלו, מנהל צוות את הצוות שלו, ומנהלים את הכול." },
  { key: "security", status: "live", icon: LockIcon, title: "אבטחה ואימות דו-שלבי", text: "אימות דו-שלבי, יומן ביקורת של כל שינוי, והפרדה מלאה בין עסקים." },
  // the three flags of chapter 18.2: shown only as "soon" until each one works
  { key: "whatsapp", status: "soon", icon: ChatIcon, title: "אף ליד לא מתפספס, והכול ב-WhatsApp", text: "מענה לליד חדש בתוך דקות, ועדכון המערכת מתוך WhatsApp." },
  { key: "ads", status: "soon", icon: ChartIcon, title: "הפרסום לומד מהמכירות", text: "החזרה לפייסבוק ולגוגל של מי מהלידים נסגר, כדי שהפרסום יביא עוד כאלה." },
  { key: "money", status: "soon", icon: BoardIcon, title: "כמה כסף מחכה לך", text: "מספר אחד בשקלים כל בוקר, ולכל שורה בו פעולה אחת." },
];

export const LIVE_FEATURES = FEATURES.filter((feature) => feature.status === "live");
export const SOON_FEATURES = FEATURES.filter((feature) => feature.status === "soon");
