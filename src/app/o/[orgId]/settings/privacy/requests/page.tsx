import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { ListCard, ListCards } from "@/components/ui/table";
import { TextLink } from "@/components/ui/text-link";
import { privacyCenterPath } from "@/features/privacy-center/paths";
import { PrivacyLinkPanel } from "@/features/privacy-requests/components/privacy-link-panel";
import { isClosed, isOverdue, REQUEST_TYPE_SHORT, STATUS_LABELS, targetLine } from "@/features/privacy-requests/model";
import { privacyRequestPath } from "@/features/privacy-requests/paths";
import { getPrivacyLinkStatus, listPrivacyRequests, REQUESTS_SHOWN } from "@/features/privacy-requests/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatNumber, zoneDate } from "@/lib/format";

export const metadata: Metadata = { title: "בקשות פרטיות" };

type Props = { params: Promise<{ orgId: string }> };

const day = (date: string) => formatDate(`${date}T12:00:00Z`);

// PRK-02: the request log (owners and admins; privacy, every plan): status and target date (30 days from receipt), overdue
// requests marked, and the public link the business puts in its privacy notice.
export default async function PrivacyRequestsPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  if (!isAdminRole(context.role)) {
    return <p className="text-sm text-ink-soft">רק בעלים ומנהלי מערכת רואים בקשות פרטיות.</p>;
  }
  const [rows, link] = await Promise.all([listPrivacyRequests(orgId), getPrivacyLinkStatus(orgId)]);
  const today = zoneDate(new Date(), context.org.timeZone);
  const open = rows.filter((row) => !isClosed(row.status));
  const late = open.filter((row) => isOverdue(row.status, row.target_date, today));

  return (
    <div className="space-y-5">
      <p className="max-w-2xl text-sm text-ink-soft">
        בקשות של אנשים לעיין במידע שהעסק שומר עליהם, לתקן אותו או למחוק אותו. על כל בקשה צריך לענות תוך 30 יום. לפני שמטפלים,
        מוודאים שהבקשה באמת של האדם. ראו גם את <TextLink href={privacyCenterPath(orgId)}>מרכז הפרטיות</TextLink>.
      </p>

      <Card aria-labelledby="privacy-link">
        <CardHeader id="privacy-link" title="הקישור לבקשות" />
        <CardBody>
          {link ? (
            <PrivacyLinkPanel orgId={orgId} active={link.active} createdText={link.createdAt ? formatDate(link.createdAt) : ""} pagesOpen={link.pagesOpen} />
          ) : null}
        </CardBody>
      </Card>

      <section aria-labelledby="privacy-requests-list" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="privacy-requests-list" className="text-lead font-semibold">
            הבקשות
          </h2>
          <p className="text-sm text-ink-soft">
            {formatNumber(open.length)} פתוחות{late.length > 0 ? ` · ${formatNumber(late.length)} באיחור` : ""}
          </p>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="אין בקשות עדיין" description="בקשה שנשלחת מהקישור מופיעה כאן, ואחראי הפרטיות, הבעלים ומנהלי המערכת מקבלים התראה." compact />
        ) : (
          <ListCards label="בקשות פרטיות">
            {rows.map((row) => {
              const overdue = isOverdue(row.status, row.target_date, today);
              const line = targetLine(row.status, row.target_date, today);
              return (
                <ListCard
                  key={row.id}
                  href={privacyRequestPath(orgId, row.id)}
                  title={`${REQUEST_TYPE_SHORT[row.request_type]} · ${row.requester_name ?? "הפרטים נמחקו"}`}
                  subtitle={`התקבלה ${formatDate(row.received_at)} · מועד יעד ${day(row.target_date)}${line ? ` (${line})` : ""}`}
                  className={overdue ? "border-danger" : undefined}
                  meta={
                    <>
                      {overdue ? <Badge tone="danger">באיחור</Badge> : null}
                      <Badge tone={isClosed(row.status) ? "neutral" : "accent"}>{STATUS_LABELS[row.status]}</Badge>
                    </>
                  }
                />
              );
            })}
          </ListCards>
        )}
        {rows.length >= REQUESTS_SHOWN ? <p className="text-sm text-ink-soft">מוצגות {formatNumber(REQUESTS_SHOWN)} הבקשות האחרונות.</p> : null}
      </section>
    </div>
  );
}
