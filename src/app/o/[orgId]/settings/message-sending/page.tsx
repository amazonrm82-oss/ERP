import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SendingHoursForm } from "@/features/message-sending/components/sending-hours-form";
import { RATE_PER_MINUTE, SHORT_DAY_UNTIL, windowText } from "@/features/message-sending/hours";
import { getSendingHours } from "@/features/message-sending/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "שעות ותקרות שליחה" };

type Props = { params: Promise<{ orgId: string }> };

// MSG-06: when messages go out to customers (owner 4 November 2026, answers (119)-(121)).
export default async function MessageSendingSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const hours = await getSendingHours(orgId);
  const editable = isAdminRole(role) && canWrite;

  const rules = (
    <Card aria-labelledby="sending-rules-title">
      <CardHeader id="sending-rules-title" title="איך זה עובד" />
      <CardBody className="space-y-3 text-sm">
        <p>
          הודעה ללקוח (אימייל, SMS או WhatsApp) שמגיע זמנה מחוץ לשעות השליחה מחכה, ויוצאת כשהשעות נפתחות. היא לא מבוטלת, אלא אם זמן האירוע שלה (למשל
          הפגישה) עבר בינתיים.
        </p>
        <p>
          תמיד נשלחים מיד: קוד אימות, ותזכורת לפגישה שמתחילה לפני שהשעות נפתחות. תזכורת גבייה, הצעת מחיר, מסמך שהלקוח ביקש והודעות שיווק מחכות לשעות
          השליחה.
        </p>
        <p className="text-ink-soft">
          קצב קבוע לכל עסק: עד {RATE_PER_MINUTE.email} אימיילים, {RATE_PER_MINUTE.sms} הודעות SMS ו-{RATE_PER_MINUTE.whatsapp} הודעות WhatsApp בדקה. מה
          שמעבר לכך יוצא בדקה הבאה.
        </p>
      </CardBody>
    </Card>
  );

  if (editable) {
    return (
      <div className="space-y-5">
        <SendingHoursForm orgId={orgId} hours={hours} />
        {rules}
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <Card aria-labelledby="sending-hours-view-title">
        <CardHeader id="sending-hours-view-title" title="שעות שליחה" />
        <CardBody>
          <DetailList>
            <Detail label="שעות" value={windowText(hours)} />
            <Detail label="ימי מנוחה וחגים" value={hours.skipRestDays ? `לא שולחים; ביום מקוצר עד ${SHORT_DAY_UNTIL}` : "שולחים כרגיל"} />
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
