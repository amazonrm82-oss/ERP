import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { MessageCapsForm } from "@/features/message-sending/components/message-caps-form";
import { MessageUsageCard } from "@/features/message-sending/components/message-usage-card";
import { SendingHoursForm } from "@/features/message-sending/components/sending-hours-form";
import { RATE_PER_MINUTE, SHORT_DAY_UNTIL, windowText } from "@/features/message-sending/hours";
import { getMessageCaps, getMessageUsage, getSendingHours } from "@/features/message-sending/queries";
import { CHANNEL_LABELS, MESSAGE_CHANNELS } from "@/features/message-sending/usage";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { formatNumber } from "@/lib/format";

export const metadata: Metadata = { title: "שעות ותקרות שליחה" };

type Props = { params: Promise<{ orgId: string }> };

// MSG-06: when messages go out to customers (owner 4 November 2026, answers (119)-(121)); MSG-05: the monthly caps of marketing
// messages and this month's usage (answers (122)-(125)). Everyone reads the hours; owners and admins see the usage and caps.
export default async function MessageSendingSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const admin = isAdminRole(role);
  const editable = admin && canWrite;
  const [hours, caps, usage] = await Promise.all([
    getSendingHours(orgId),
    getMessageCaps(orgId),
    admin ? getMessageUsage(orgId) : Promise.resolve({ allowed: false } as const),
  ]);

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
        <p>
          כשהודעות השיווק מגיעות ל-80% מהתקרה החודשית, הבעלים ומנהלי המערכת מקבלים התראה. כשהתקרה מלאה הם מקבלים התראה, ושוב כל יום שיש הודעות שמחכות.
        </p>
        <p className="text-ink-soft">
          קצב קבוע לכל עסק: עד {RATE_PER_MINUTE.email} אימיילים, {RATE_PER_MINUTE.sms} הודעות SMS ו-{RATE_PER_MINUTE.whatsapp} הודעות WhatsApp בדקה. מה
          שמעבר לכך יוצא בדקה הבאה.
        </p>
      </CardBody>
    </Card>
  );

  const usageCard = usage.allowed ? <MessageUsageCard month={usage.month} channels={usage.channels} /> : null;

  if (editable) {
    return (
      <div className="space-y-5">
        <SendingHoursForm orgId={orgId} hours={hours} />
        {usageCard}
        <MessageCapsForm orgId={orgId} caps={caps} />
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
            {admin
              ? MESSAGE_CHANNELS.map((channel) => {
                  const cap = caps[channel];
                  return <Detail key={channel} label={`תקרת שיווק חודשית, ${CHANNEL_LABELS[channel]}`} value={cap === null ? "בלי תקרה" : formatNumber(cap)} />;
                })
              : null}
          </DetailList>
          <p className="mt-4 text-sm text-ink-soft">{admin ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות."}</p>
        </CardBody>
      </Card>
      {usageCard}
      {rules}
    </div>
  );
}
