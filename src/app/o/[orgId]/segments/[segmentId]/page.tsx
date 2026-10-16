import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { conditionCount } from "@/features/list-filters/model";
import { removeFromSegmentAction } from "@/features/segments/actions";
import { DeleteSegmentButton, RenameSegmentForm } from "@/features/segments/components/segment-forms";
import { canWriteSegments, SEGMENT_KIND_LABELS, SEGMENT_OBJECT_LABELS, segmentListHref } from "@/features/segments/model";
import { segmentPath, segmentsPath } from "@/features/segments/paths";
import { countDynamicSegment, getSegment, listSegmentMembers } from "@/features/segments/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatNumber } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { firstParam, parsePage } from "@/lib/search";

export const metadata: Metadata = { title: "סגמנט" };

type Props = {
  params: Promise<{ orgId: string; segmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** SEG-01: one segment. A dynamic one shows its count and opens the list with its filter; a static one lists its records. */
export default async function SegmentPage({ params, searchParams }: Props) {
  const { orgId, segmentId } = await params;
  if (!isUuid(segmentId)) notFound();
  const query = await searchParams;
  const context = await getOrgContext(orgId);
  const segment = await getSegment(orgId, segmentId);
  if (!segment) notFound();
  const writer = canWriteSegments(context.role, context.canWrite);
  const page = parsePage(firstParam(query.page));
  const listPath = segment.objectType === "lead" ? paths.leads(orgId) : paths.contacts(orgId);
  const recordPath = (id: string) => (segment.objectType === "lead" ? paths.lead(orgId, id) : paths.contact(orgId, id));
  const plural = SEGMENT_OBJECT_LABELS[segment.objectType];

  const [dynamic, members] = await Promise.all([
    segment.kind === "dynamic" ? countDynamicSegment(orgId, segment, context.user.id) : null,
    segment.kind === "static" ? listSegmentMembers(orgId, segment, page) : null,
  ]);

  return (
    <>
      <PageHeader
        title={segment.name}
        description={`סגמנט של ${plural} · ${SEGMENT_KIND_LABELS[segment.kind]}`}
        back={{ href: segmentsPath(orgId), label: "סגמנטים" }}
      />
      <div className="space-y-6">
        {segment.kind === "dynamic" ? (
          <Card aria-labelledby="segment-filter">
            <CardHeader id="segment-filter" title="לפי סינון" />
            <CardBody className="space-y-3 text-md">
              {segment.filter && dynamic ? (
                <>
                  <p>
                    <strong className="text-2xl font-semibold">{formatNumber(dynamic.count)}</strong>{" "}
                    <span className="text-ink-soft">{plural} מתאימים עכשיו (מתוך אלה שאתם רואים).</span>
                  </p>
                  <p className="text-ink-soft">
                    {conditionCount(segment.filter) === 1 ? "תנאי אחד" : `${conditionCount(segment.filter)} תנאים`}.
                    {dynamic.skipped > 0
                      ? ` ${dynamic.skipped === 1 ? "תנאי אחד לא חל" : `${dynamic.skipped} תנאים לא חלים`}: השדה או הבחירה שבו הוסרו מאז.`
                      : ""}
                  </p>
                  <ButtonLink href={segmentListHref(listPath, segment.filter)} variant="secondary">
                    פתיחת הרשימה עם הסינון
                  </ButtonLink>
                </>
              ) : (
                <p className="text-ink-soft">אי אפשר לקרוא את הסינון השמור. מחקו את הסגמנט ושמרו אותו מחדש מהרשימה.</p>
              )}
            </CardBody>
          </Card>
        ) : members ? (
          <Card aria-labelledby="segment-members">
            <CardHeader
              id="segment-members"
              title={`רשומות בסגמנט (${formatNumber(members.total)})`}
            />
            {members.members.length > 0 ? (
              <ul className="border-t border-line">
                {members.members.map((member) => (
                  <li key={member.id} className="flex min-h-14 flex-wrap items-center gap-3 border-b border-line px-4 py-2 last:border-b-0 sm:px-5">
                    <span className="min-w-0 flex-1">
                      <Link href={recordPath(member.recordId)} className="font-medium break-words text-accent-strong underline-offset-2 hover:underline">
                        {member.name}
                      </Link>
                      <span className="block text-sm text-ink-soft">נוסף ב-{formatDate(member.addedAt)}</span>
                    </span>
                    {writer ? (
                      <ActionButton
                        action={removeFromSegmentAction.bind(null, orgId, segment.id, member.id)}
                        pendingText="מסירים…"
                        variant="ghost"
                        confirm={`להסיר את "${member.name}" מהסגמנט?`}
                        confirmLabel="הסרה מהסגמנט"
                        srLabel={member.name}
                      >
                        הסרה
                      </ActionButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                compact
                kind={page > 1 ? "search" : "start"}
                title={page > 1 ? "אין עוד רשומות" : "הסגמנט ריק"}
                description={`מוסיפים ${plural} מהרשימה: בוחרים שורות, ובפעולות בוחרים "הוספה לסגמנט".`}
                action={
                  <ButtonLink href={listPath} variant="secondary">
                    לרשימת ה{plural}
                  </ButtonLink>
                }
              />
            )}
          </Card>
        ) : null}
        {members ? <Pagination page={page} hasMore={members.hasMore} hrefFor={(target) => (target > 1 ? `${segmentPath(orgId, segment.id)}?page=${target}` : segmentPath(orgId, segment.id))} /> : null}

        {writer ? (
          <Card aria-labelledby="segment-manage">
            <CardHeader id="segment-manage" title="ניהול" />
            <CardBody className="space-y-4">
              <RenameSegmentForm orgId={orgId} segmentId={segment.id} name={segment.name} />
              <DeleteSegmentButton orgId={orgId} segmentId={segment.id} name={segment.name} />
            </CardBody>
          </Card>
        ) : (
          <p className="text-sm text-ink-soft">
            <Badge>צפייה בלבד</Badge> סגמנטים יוצרים ומשנים בעלי העסק, מנהלי מערכת ומנהלים.
          </p>
        )}
      </div>
    </>
  );
}
