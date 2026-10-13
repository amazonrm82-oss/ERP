import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Card, CardBody } from "@/components/ui/card";
import { LockIcon } from "@/components/ui/icons";
import { getOrgContextAllowClosed } from "@/features/shell/queries";
import { leaveClosedOrganizationAction } from "@/features/suspended/actions";
import { SupportContact } from "@/features/support/components/support-contact";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "הגישה לעסק סגורה" };

type Props = { params: Promise<{ orgId: string }> };

// BIL-09 (owner, 13 October 2026): a suspended business has no access until payment. Its data is
// kept and its public forms keep taking leads. The owner may choose a plan or download everything.
export default async function SuspendedPage({ params }: Props) {
  const { orgId } = await params;
  const { org, role, closed } = await getOrgContextAllowClosed(orgId);
  if (!closed) {
    redirect(paths.org(orgId));
  }
  const cancelled = org.status === "cancelled";

  return (
    <Card>
      <CardBody className="space-y-5 py-8 sm:px-8">
        <div className="space-y-2">
          <LockIcon className="size-8 text-ink-soft" aria-hidden="true" />
          <h1 className="text-2xl font-semibold">{cancelled ? "המנוי בוטל והגישה לעסק סגורה" : "הגישה לעסק סגורה עד לתשלום"}</h1>
          {role === "owner" ? (
            <p className="text-md text-ink-soft">
              {cancelled
                ? "הנתונים של העסק שמורים. אפשר להוריד את כולם, או לבחור חבילה כדי לחזור לעבוד."
                : "הנתונים של העסק שמורים, והטפסים באתר ממשיכים לקלוט לידים. אחרי בחירת חבילה ותשלום הכול חוזר, כולל הלידים שהגיעו בינתיים."}
            </p>
          ) : (
            <p className="text-md text-ink-soft">הגישה לעסק סגורה עד לתשלום. פנו לבעלים של העסק.</p>
          )}
        </div>

        {role === "owner" ? (
          <>
            <div className="flex flex-wrap gap-2">
              <ButtonLink href={paths.settingsPlan(orgId)}>בחירת חבילה ותשלום</ButtonLink>
              <a href={paths.fullExport(orgId)} className={buttonClasses("secondary", "md")} download>
                הורדת הנתונים שלי
              </a>
            </div>
            <div className="space-y-2 border-t border-line pt-4">
              <p className="text-md">החיוב עדיין לא פעיל, פנו לתמיכה:</p>
              <SupportContact />
            </div>
          </>
        ) : (
          // owner's answer of 13 October 2026: anyone but the owner may leave a closed business
          <ConfirmButton
            variant="secondary"
            size="md"
            title={`לעזוב את ${org.name}? לא תוכלו לחזור אליו בלי הזמנה חדשה.`}
            confirmLabel="עזיבת העסק"
            action={leaveClosedOrganizationAction.bind(null, orgId)}
          >
            עזיבת העסק
          </ConfirmButton>
        )}

        <p className="text-sm">
          <Link href={paths.home} className="text-accent underline underline-offset-4 hover:text-accent-strong">
            החלפת עסק
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
