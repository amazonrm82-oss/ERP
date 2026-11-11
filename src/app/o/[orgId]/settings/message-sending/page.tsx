import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { MeetingMessagesForm } from "@/features/message-sending/components/meeting-messages-form";
import { MessageCapsForm } from "@/features/message-sending/components/message-caps-form";
import { MessageUsageCard } from "@/features/message-sending/components/message-usage-card";
import { SendingHoursForm } from "@/features/message-sending/components/sending-hours-form";
import { SmsSenderForm } from "@/features/message-sending/components/sms-sender-form";
import { RATE_PER_MINUTE, SHORT_DAY_UNTIL, windowText } from "@/features/message-sending/hours";
import { MEETING_MESSAGE_TEXTS, MEETING_REMINDERS_FEATURE } from "@/features/message-sending/meeting-messages";
import { getMeetingMessages, getMessageCaps, getMessageUsage, getSendingHours, getSmsSender } from "@/features/message-sending/queries";
import { CHANNEL_LABELS, MESSAGE_CHANNELS } from "@/features/message-sending/usage";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatNumber } from "@/lib/format";

export const metadata: Metadata = { title: "שעות ותקרות שליחה" };

type Props = { params: Promise<{ orgId: string }> };

// CAL-12: the meeting messages to the customer (all off by default; owners and admins switch them).
// MSG-06: when messages go out to customers (owner 4 November 2026, answers (119)-(121)); MSG-05: the monthly caps of marketing
// messages and this month's usage (answers (122)-(125)). Everyone reads the hours; owners and admins see the usage and caps.
export default async function MessageSendingSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const admin = isAdminRole(role);
  const editable = admin && canWrite;
  const [hours, caps, meetingMessages, meetingRemindersInPlan, usage, smsSender, smsInPlan] = await Promise.all([
    getSendingHours(orgId),
    getMessageCaps(orgId),
    getMeetingMessages(orgId),
    orgHasFeature(orgId, MEETING_REMINDERS_FEATURE),
    admin ? getMessageUsage(orgId) : Promise.resolve({ allowed: false } as const),
    getSmsSender(orgId),
    orgHasFeature(orgId, "sms"),
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
          כשהודעות השיווק מגיעות ל-80% מהתקרה החודשית, הבעלים ומנהלי המערכת מקבלים התראה. כשהתקרה מלאה הם מקבלים התראה, ושוב פעם ביום (לפי לוח השנה) כל עוד יש הודעות שמחכות.
        </p>
        <p>
          {/* SMS (owner (210) ב): the plan's SMS quota covers every SMS to a customer; a verification code is never counted */}
          מכסת ה-SMS של החבילה חלה על כל הודעת SMS ללקוח: מהכרטיס, מאוטומציות, אישורי ותזכורות פגישה והודעות כרטיסייה. כשהיא מלאה, ההודעות מחכות עד
          החודש הבא או עד שהחבילה תוגדל, ושם אפשר גם לבטל אותן. קוד אימות לא נספר ויוצא תמיד.
        </p>
        <p className="text-ink-soft">
          קצב קבוע לכל עסק: עד {RATE_PER_MINUTE.email} אימיילים, {RATE_PER_MINUTE.sms} הודעות SMS ו-{RATE_PER_MINUTE.whatsapp} הודעות WhatsApp בדקה. מה
          שמעבר לכך יוצא בדקה הבאה. גם במערכת כולה יש קצב לכל ערוץ, ובעומס חריג הודעה יכולה לחכות דקה. קוד אימות יוצא תמיד מיד.
        </p>
      </CardBody>
    </Card>
  );

  const usageCard = usage.allowed ? <MessageUsageCard orgId={orgId} month={usage.month} channels={usage.channels} /> : null;

  if (editable) {
    return (
      <div className="space-y-5">
        <SendingHoursForm orgId={orgId} hours={hours} />
        {usageCard}
        <MessageCapsForm orgId={orgId} caps={caps} />
        <MeetingMessagesForm orgId={orgId} settings={meetingMessages} available={meetingRemindersInPlan} />
        <SmsSenderForm orgId={orgId} sender={smsSender} smsInPlan={smsInPlan} />
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
            <Detail label={MEETING_MESSAGE_TEXTS.confirm} value={meetingMessages.confirm ? "פעיל" : "כבוי"} />
            <Detail label={MEETING_MESSAGE_TEXTS.day} value={meetingMessages.day ? "פעיל" : "כבוי"} />
            <Detail label={MEETING_MESSAGE_TEXTS.hour} value={meetingMessages.hour ? "פעיל" : "כבוי"} />
            <Detail label="שם השולח ב-SMS" value={smsSender.effective ?? "שם השולח הכללי של המערכת"} />
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
