import { Card, CardBody, CardHeader } from "@/components/ui/card";

// HEB-02: what the business calendar (rest days, holidays, occasions) changes in
// the system, in one place. Keep in step with the features that read it.
export const BUSINESS_CALENDAR_EFFECTS = [
  "היעד לזמן תגובה לליד חדש נספר רק בזמן עבודה: ליד שנכנס ביום מנוחה לא נחשב באיחור, וגם לא עובר לנציג אחר, עד שמתחיל יום העבודה הבא.",
  "לידים בסבב מגיעים רק בימי עבודה, כשמוגדרות שעות עבודה לעסק או לעובד.",
  "\"בעוד כמה ימי עסקים\" במשימות ובאוטומציות מדלג על ימי המנוחה והחגים.",
  "תאריך יעד של משימה שנופל ביום מנוחה מקבל התראה והצעה להעביר אותו ליום העבודה הבא. אפשר גם להשאיר אותו.",
  "דחייה של משימה \"למחר\" או \"לעוד שבוע\" עוברת ליום העבודה הבא, אם היום ההוא הוא יום מנוחה.",
  "משימה חוזרת שמסומן בה \"רק בימי עבודה\" נקבעת ליום העבודה הבא.",
  "בטופס הלידים, \"התקשרו אליי\" מציע רק שעות בימי עבודה.",
  "משימת הקליטה אחרי עסקה שנסגרה נקבעת ליום העבודה הבא.",
] as const;

/** "What the business calendar affects": a short list on the rest days settings page. */
export function BusinessCalendarEffects() {
  return (
    <Card aria-labelledby="calendar-effects-title">
      <CardHeader id="calendar-effects-title" title="על מה ימי המנוחה משפיעים" />
      <CardBody>
        <ul className="list-disc space-y-1.5 ps-5 text-md">
          {BUSINESS_CALENDAR_EFFECTS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
