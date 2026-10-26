import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";
import { RetentionForm } from "@/features/lead-retention/components/retention-form";
import { formatDayIn, RETENTION_NOTICE_DAYS } from "@/features/lead-retention/model";
import { retentionListPath } from "@/features/lead-retention/paths";
import { getRetentionStatus } from "@/features/lead-retention/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { byGender } from "@/features/terminology/terms";
import { getOrgTerms } from "@/features/terminology/queries";
import { formatNumber } from "@/lib/format";
import { TIME_ZONE } from "@/lib/app";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "מדיניות שמירה" };

type Props = { params: Promise<{ orgId: string }> };

// PRV-01: inactive leads move to the recycle bin after a number of months, with a list to the owners and admins first.
export default async function RetentionSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  if (!isAdminRole(context.role)) {
    return <p className="text-sm text-ink-soft">רק בעלים ומנהלי מערכת רואים את מדיניות השמירה.</p>;
  }
  // dates in the business's own time zone
  const timeZone = context.org?.timeZone ?? TIME_ZONE;
  const [status, terms] = await Promise.all([getRetentionStatus(orgId), getOrgTerms(orgId)]);
  const lead = terms.lead;
  const words = { singular: lead.singular, plural: lead.plural, oneWord: byGender(lead, "אחד", "אחת") };
  const round = status.open_round;

  return (
    <div className="space-y-5">
      <Card aria-labelledby="retention-how">
        <CardHeader id="retention-how" title="איך זה עובד" />
        <CardBody className="space-y-2 text-sm">
          <p>
            המדיניות מעבירה לסל המחזור {lead.plural} בלי קשר (שיחה, הודעה, הערה או פגישה) במשך מספר החודשים שבוחרים, ובלי משימה
            פתוחה או פגישה עתידית. {lead.plural} שהומרו לא נכללים.
          </p>
          <p>
            {RETENTION_NOTICE_DAYS} יום לפני כן נשלחת לכל הבעלים ומנהלי המערכת רשימה, ובה אפשר לסמן &quot;להשאיר&quot;. סימון כזה, או
            שחזור מסל המחזור, מתחיל את הספירה מחדש.
          </p>
          <p>
            בסל המחזור אפשר לשחזר במשך 30 יום. אחר כך המחיקה סופית, וגם הפרטים האישיים נמחקים מיומן הביקורת. זו לא מחיקה לבקשת
            האדם, ולכן לא נרשם &quot;לא לפנות&quot;; הסרה מדיוור שכבר נרשמה נשארת.
          </p>
        </CardBody>
      </Card>

      <Card aria-labelledby="retention-state">
        <CardHeader id="retention-state" title={status.enabled ? `המדיניות פעילה: ${status.months} חודשים` : "המדיניות כבויה"} />
        <CardBody className="space-y-4">
          {round ? (
            <p className="text-sm">
              ברשימה הפתוחה {formatNumber(round.total)} {lead.plural}
              {round.kept > 0 ? ` (${formatNumber(round.kept)} סומנו "להשאיר")` : ""}. המעבר לסל המחזור ב-{formatDayIn(round.due_at, timeZone)}.{" "}
              <TextLink href={retentionListPath(orgId)}>לרשימה</TextLink>
            </p>
          ) : status.enabled ? (
            <p className="text-sm text-ink-soft">אין עכשיו רשימה פתוחה. בדיקה נעשית כל שעה.</p>
          ) : null}
          {status.last_round ? (
            <p className="text-sm text-ink-soft">
              בסבב האחרון ({formatDayIn(status.last_round.finished_at, timeZone)}) עברו לסל המחזור {formatNumber(status.last_round.binned)} {lead.plural}.{" "}
              <TextLink href={paths.settingsTrash(orgId)}>לסל המחזור</TextLink>
            </p>
          ) : null}
          {context.canWrite ? (
            <RetentionForm orgId={orgId} enabled={status.enabled} months={status.months} words={words} />
          ) : (
            <p className="text-sm text-ink-soft">העסק במצב קריאה בלבד, ולכן אי אפשר לשנות את המדיניות כרגע.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
