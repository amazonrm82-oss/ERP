import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PauseSendingForm, ResumeSendingForm } from "@/features/sending-pause/components/sending-pause-form";
import { getSendingPause } from "@/features/sending-pause/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "עצירת שליחה ללקוחות" };

type Props = { params: Promise<{ orgId: string }> };

// HEB-09: "stop everything" for days of mourning and emergencies. Owners and admins pause and resume; everyone else reads.
export default async function SendingPausePage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const pause = await getSendingPause(orgId);
  const editable = isAdminRole(context.role);
  const names = await getUserNames([pause.pausedBy, pause.resumedBy]);
  const by = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">
        ביום אבל או במצב חירום אפשר לעצור בלחיצה אחת כל שליחה אוטומטית ללקוחות: הודעות שיווק ותזכורות. השליחה לא חוזרת לבד, רק כשמחדשים אותה.
        התראות ומשימות לצוות ממשיכות כרגיל, וגם הודעה שנציג שולח בעצמו (למשל ב-WhatsApp).
      </p>
      <Card aria-labelledby="sending-pause-title">
        <CardHeader id="sending-pause-title" title={pause.paused ? "השליחה ללקוחות מושהית" : "השליחה ללקוחות פעילה"} />
        <CardBody className="space-y-4">
          {pause.paused ? (
            <dl className="grid gap-x-3 gap-y-1 text-md sm:grid-cols-[auto_1fr]">
              <dt className="font-medium">מאז</dt>
              <dd className="text-ink-soft">
                {pause.pausedAt ? formatDateTime(pause.pausedAt) : "לא ידוע"}
                {by(pause.pausedBy) ? `, על ידי ${by(pause.pausedBy)}` : ""}
              </dd>
              <dt className="font-medium">סיבה</dt>
              <dd className="break-words whitespace-pre-wrap text-ink-soft">{pause.reason}</dd>
            </dl>
          ) : pause.resumedAt ? (
            <p className="text-md text-ink-soft">
              חודשה ב-{formatDateTime(pause.resumedAt)}
              {by(pause.resumedBy) ? `, על ידי ${by(pause.resumedBy)}` : ""}.
            </p>
          ) : null}
          {editable ? (
            pause.paused ? (
              <ResumeSendingForm orgId={orgId} />
            ) : (
              <PauseSendingForm orgId={orgId} />
            )
          ) : (
            <p className="text-sm text-ink-soft">רק בעלים ומנהלי מערכת יכולים לעצור ולחדש את השליחה.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
