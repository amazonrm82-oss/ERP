import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";
import { messageTemplatesPath } from "@/features/message-templates/paths";
import { expiryDaysText, lowEntriesText } from "@/features/punch-cards/alerts";
import { PunchAlertSettingsForm } from "@/features/punch-cards/components/punch-alert-settings-form";
import { getPunchAlertSettings } from "@/features/punch-cards/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "כרטיסיות" };

type Props = { params: Promise<{ orgId: string }> };

// PKG-03: when a punch card alerts its rep (few entries left, the last day near). Everyone reads; owners and admins change.
export default async function PunchCardSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const [{ role, canWrite }, settings, inPlan] = await Promise.all([getOrgContext(orgId), getPunchAlertSettings(orgId), orgHasFeature(orgId, "punch_cards")]);
  const editable = isAdminRole(role) && canWrite;

  const rules = (
    <Card aria-labelledby="punch-alerts-rules-title">
      <CardHeader id="punch-alerts-rules-title" title="איך זה עובד" />
      <CardBody className="space-y-3 text-sm">
        <p>
          כל כרטיסייה פעילה שולחת התראה אחת כשנשארו בה מעט כניסות, והתראה אחת כשהתוקף שלה מתקרב. ההתראה מגיעה לבעלים של איש הקשר, ואם אין לו בעלים
          פעיל, לבעלים ולמנהלי המערכת של העסק. ההתראות נשלחות מ-8:00 בבוקר.
        </p>
        <p>
          גם כרטיסייה שנוצלה עד הסוף שולחת את ההתראה &quot;נשארו מעט&quot;, אם עוד לא שלחה. כרטיסייה שנפתחה כשהתוקף שלה כבר היה קרוב לא שולחת התראה על
          התוקף, וכרטיסייה שפג תוקפה לא שולחת התראות. כרטיסיות שכבר היו במצב של התראה כשההתראות התחילו לפעול בעסק, או כששיניתם את המספרים כאן, לא שולחות עליו התראה.
        </p>
        <p className="text-ink-soft">
          בכרטיס איש הקשר מופיעים התגים &quot;נשארו מעט&quot; ו&quot;התוקף מתקרב&quot; לפי אותם מספרים, וכפתור &quot;חידוש&quot; שפותח כרטיסייה חדשה מאותו סוג. כל
          אחד יכול להשתיק את ההתראות האלה <TextLink href={paths.settingsAccount(orgId)}>בהגדרות ההתראות שלו</TextLink>.
        </p>
        <p>
          כשההודעה ללקוח מופעלת, הלקוח מקבל הודעת שירות מהתבנית של ההתראה: בערוץ המועדף שלו, ואם אין או שאין לו כתובת בערוץ הזה, ב-SMS, ב-WhatsApp או
          באימייל, לפי מה שיש. אין בהודעה מחיר, קישור או הצעת חידוש. הודעה לא נשלחת לכתובת שברשימת החסימה או שנמחקה לבקשת הלקוח, ולא בזמן שהשליחה
          ללקוחות עצורה. את הנוסח משנים ב<TextLink href={messageTemplatesPath(orgId)}>תבניות ההודעה</TextLink>; תבנית שנמחקה או כובתה לא נשלחת.
        </p>
        {inPlan ? null : <p className="text-ink-soft">הכרטיסיות לא כלולות בחבילה של העסק, ולכן לא נשלחות התראות.</p>}
      </CardBody>
    </Card>
  );

  if (editable) {
    return (
      <div className="space-y-5">
        <PunchAlertSettingsForm orgId={orgId} lowEntries={settings.lowEntries} expiryDays={settings.expiryDays} customerMessages={settings.customerMessages} />
        {rules}
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <Card aria-labelledby="punch-alerts-title">
        <CardHeader id="punch-alerts-title" title="התראות כרטיסייה" />
        <CardBody>
          <DetailList>
            <Detail label="נשארו מעט כניסות" value={lowEntriesText(settings.lowEntries)} />
            <Detail label="התוקף מתקרב" value={expiryDaysText(settings.expiryDays)} />
            <Detail label="הודעה ללקוח" value={settings.customerMessages ? "נשלחת" : "לא נשלחת"} />
          </DetailList>
          <p className="mt-4 text-sm text-ink-soft">
            {isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות."}
          </p>
        </CardBody>
      </Card>
      {rules}
    </div>
  );
}
