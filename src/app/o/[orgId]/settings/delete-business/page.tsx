import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CancelOrgDeletionForm, ConfirmOrgDeletionForm, RequestOrgDeletionForm } from "@/features/org-deletion/components/org-deletion-forms";
import { getOrgDeletionStatus } from "@/features/org-deletion/queries";
import { deletionDayText, ORG_DELETION_CODE_MINUTES, ORG_DELETION_WAIT_DAYS } from "@/features/org-deletion/texts";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "מחיקת העסק" };

type Props = { params: Promise<{ orgId: string }> };

// ADM-03 (owner, 13 November 2026, answers (361) ב, (362) ב, (363) ב): only the business's owner asks, cancels and sees the steps
export default async function DeleteBusinessPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const owner = context.role === "owner" && !context.supportUntil;
  const status = await getOrgDeletionStatus(orgId);
  const zone = context.org.timeZone;
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">
        מחיקת העסק מוחקת את כל הנתונים והקבצים שלו: רשומות, מסמכים, תשלומים, הגדרות והיסטוריה. חשבונות המשתמשים לא נמחקים, והם
        ממשיכים לעבוד בעסקים אחרים שלהם. לפני המחיקה מומלץ להוריד{" "}
        <Link href={paths.imports(orgId)} className="underline underline-offset-4">
          ייצוא מלא של העסק
        </Link>
        .
      </p>
      <Card aria-labelledby="delete-business-title">
        <CardHeader id="delete-business-title" title={status.pending ? "העסק ממתין למחיקה" : "מחיקת העסק"} />
        <CardBody className="space-y-4">
          {!owner ? (
            status.pending ? (
              <p className="text-md">
                העסק יימחק ב-{deletionDayText(status.scheduledFor, zone)}. עד אז אפשר רק לקרוא ולייצא. לשאלות, פנו לבעל העסק.
              </p>
            ) : (
              <p className="text-md text-ink-soft">רק בעל העסק יכול לבקש למחוק אותו.</p>
            )
          ) : status.pending ? (
            <>
              <p className="text-md">
                המחיקה אושרה. ב-{deletionDayText(status.scheduledFor, zone)} יימחקו כל נתוני העסק וקבציו. עד אז העסק במצב קריאה בלבד: אפשר
                לקרוא ולהוריד ייצוא מלא, ואי אפשר לשנות דבר.
              </p>
              <CancelOrgDeletionForm orgId={orgId} label="ביטול המחיקה" />
            </>
          ) : status.awaitingUntil ? (
            <>
              <p className="text-md">
                שלחנו קוד לאימייל שלכם. הקלידו אותו כאן כדי לאשר את המחיקה. הקוד בתוקף {ORG_DELETION_CODE_MINUTES} דקות. עד שתאשרו, שום דבר
                לא משתנה.
              </p>
              <ConfirmOrgDeletionForm orgId={orgId} />
              <CancelOrgDeletionForm orgId={orgId} label="ביטול הבקשה" />
            </>
          ) : (
            <>
              <ol className="list-decimal space-y-1 ps-5 text-md">
                <li>מקלידים את שם העסק ושולחים. צריך להיות מחוברים עם אימות דו-שלבי.</li>
                <li>מקלידים את הקוד שמגיע לאימייל שלכם (בתוקף {ORG_DELETION_CODE_MINUTES} דקות).</li>
                <li>מהאישור העסק במצב קריאה בלבד, ואחרי {ORG_DELETION_WAIT_DAYS} יום הוא נמחק. עד אז אפשר לבטל.</li>
              </ol>
              <RequestOrgDeletionForm orgId={orgId} businessName={context.org.name} />
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
