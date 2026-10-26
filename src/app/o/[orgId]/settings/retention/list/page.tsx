import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { Pagination } from "@/components/ui/pagination";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { TextLink } from "@/components/ui/text-link";
import { KeepButton } from "@/features/lead-retention/components/keep-button";
import { formatDayIn, retentionRowState } from "@/features/lead-retention/model";
import { retentionListPath, retentionSettingsPath } from "@/features/lead-retention/paths";
import { getRetentionRound } from "@/features/lead-retention/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { TIME_ZONE } from "@/lib/app";
import { paths } from "@/lib/paths";
import { parsePage } from "@/lib/search";

export const metadata: Metadata = { title: "רשימת מדיניות השמירה" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// PRV-01: the leads the open round will move to the recycle bin; "להשאיר" takes one off and restarts its count.
export default async function RetentionListPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const page = parsePage((await searchParams).page);
  const context = await getOrgContext(orgId);
  if (!isAdminRole(context.role)) {
    return <p className="text-sm text-ink-soft">רק בעלים ומנהלי מערכת רואים את רשימת מדיניות השמירה.</p>;
  }
  // dates in the business's own time zone
  const timeZone = context.org?.timeZone ?? TIME_ZONE;
  const [round, terms] = await Promise.all([getRetentionRound(orgId, page), getOrgTerms(orgId)]);
  const lead = terms.lead;

  if (!round.round) {
    return (
      <EmptyState
        kind="done"
        title="אין רשימה פתוחה"
        description={`כשתהיה רשימה של ${lead.plural} למעבר לסל המחזור, היא תופיע כאן.`}
        action={<TextLink href={retentionSettingsPath(orgId)}>למדיניות השמירה</TextLink>}
      />
    );
  }

  return (
    <Card aria-labelledby="retention-list">
      <CardHeader id="retention-list" title={`עוברים לסל המחזור ב-${formatDayIn(round.round.due_at, timeZone)}`} />
      <CardBody className="space-y-3">
        <p className="text-sm text-ink-soft">
          {lead.plural} בלי קשר {round.round.months} חודשים, בלי משימה פתוחה ובלי פגישה עתידית. מי שסומן &quot;להשאיר&quot; לא יעבור, והספירה
          שלו מתחילה מחדש.
        </p>
        <Table caption={`רשימת ${lead.plural} של מדיניות השמירה`} hideCaption>
          <thead>
            <tr>
              <Th>שם</Th>
              <Th className="hidden sm:table-cell">קשר אחרון</Th>
              <Th className="hidden sm:table-cell">נוצר</Th>
              <Th>
                <span className="sr-only">פעולה</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {round.leads.map((row) => {
              const name = row.name || row.phone || row.email || lead.singular;
              return (
                <Tr key={row.id}>
                  <Td>
                    <TextLink href={paths.lead(orgId, row.id)}>{name}</TextLink>
                    <span className="block text-xs text-ink-soft sm:hidden">
                      קשר אחרון: {row.last_contacted_at ? formatDayIn(row.last_contacted_at, timeZone) : "אף פעם"}
                    </span>
                  </Td>
                  <Td className="hidden sm:table-cell">{row.last_contacted_at ? formatDayIn(row.last_contacted_at, timeZone) : "אף פעם"}</Td>
                  <Td className="hidden sm:table-cell">{formatDayIn(row.created_at, timeZone)}</Td>
                  <Td>
                    {retentionRowState(row) ? (
                      <span className="text-sm text-ink-soft">{retentionRowState(row)}</span>
                    ) : context.canWrite ? (
                      <KeepButton orgId={orgId} leadId={row.id} name={name} />
                    ) : null}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
        <Pagination page={page} hasMore={round.has_more} hrefFor={(p) => retentionListPath(orgId, p)} />
      </CardBody>
    </Card>
  );
}
