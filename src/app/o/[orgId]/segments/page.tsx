import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { ForwardIcon, InboxIcon, UsersIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { getOrgModules } from "@/features/modules/queries";
import { NewStaticSegmentForm } from "@/features/segments/components/segment-forms";
import { canWriteSegments, SEGMENT_KIND_LABELS, SEGMENT_OBJECT_LABELS, SEGMENT_OBJECTS, SEGMENTS_NOT_IN_PLAN } from "@/features/segments/model";
import { segmentPath } from "@/features/segments/paths";
import { listSegments } from "@/features/segments/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "סגמנטים" };

type Props = { params: Promise<{ orgId: string }> };

/** SEG-01: the business's segments of leads and of contacts. Everyone reads them; owners, admins and managers write. */
export default async function SegmentsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const [segments, inPlan, modules] = await Promise.all([listSegments(orgId), orgHasFeature(orgId, "segments"), getOrgModules(orgId)]);
  const writer = canWriteSegments(role, canWrite);

  return (
    <>
      <PageHeader title="סגמנטים" description="קבוצות של לידים או של אנשי קשר, לעבודה ולדיוור בהמשך." />
      <div className="space-y-6">
        <Card aria-labelledby="segments-about">
          <CardHeader id="segments-about" title="שני סוגים" />
          <CardBody className="space-y-2 text-md text-ink-soft">
            <p>
              <strong className="text-ink">לפי סינון:</strong> שומרים סינון של רשימת{" "}
              <Link href={paths.leads(orgId)} className="font-medium text-accent-strong underline-offset-2 hover:underline">
                הלידים
              </Link>{" "}
              או{" "}
              <Link href={paths.contacts(orgId)} className="font-medium text-accent-strong underline-offset-2 hover:underline">
                אנשי הקשר
              </Link>{" "}
              (בכפתור &quot;שמירה כסגמנט&quot; שליד הסינון). הסגמנט מתעדכן לבד: בכל כניסה רואים את מי שמתאים לסינון באותו רגע.
            </p>
            <p>
              <strong className="text-ink">רשימה ידנית:</strong> יוצרים כאן, ומוסיפים רשומות מהרשימה: בוחרים שורות ובוחרים &quot;הוספה לסגמנט&quot;.
            </p>
          </CardBody>
        </Card>

        {SEGMENT_OBJECTS.map((objectType) => {
          const rows = segments.filter((s) => s.objectType === objectType);
          const titleId = `segments-${objectType}`;
          return (
            <Card key={objectType} aria-labelledby={titleId}>
              <CardHeader id={titleId} title={`סגמנטים של ${SEGMENT_OBJECT_LABELS[objectType]}`} />
              {rows.length > 0 ? (
                <ul className="border-t border-line">
                  {rows.map((segment) => (
                    <li key={segment.id} className="border-b border-line last:border-b-0">
                      <Link href={segmentPath(orgId, segment.id)} className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-canvas sm:px-5">
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium break-words text-ink">{segment.name}</span>
                          <span className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                            <Badge tone={segment.kind === "dynamic" ? "accent" : "neutral"}>{SEGMENT_KIND_LABELS[segment.kind]}</Badge>
                          </span>
                        </span>
                        <ForwardIcon className="size-4 shrink-0 text-ink-soft" aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  compact
                  icon={objectType === "lead" ? <InboxIcon /> : <UsersIcon />}
                  title={`עוד אין סגמנטים של ${SEGMENT_OBJECT_LABELS[objectType]}`}
                  description={`סגמנט הוא קבוצה שמורה של ${SEGMENT_OBJECT_LABELS[objectType]}: לפי סינון של הרשימה, או רשימה ידנית.`}
                  action={
                    // saving a filter as a segment is for writers, only with segments in the plan, and leads only while their module is on
                    inPlan && writer && (objectType !== "lead" || modules.leads) ? (
                      <ButtonLink href={objectType === "lead" ? paths.leads(orgId) : paths.contacts(orgId)} variant="secondary">
                        {`לרשימת ה${SEGMENT_OBJECT_LABELS[objectType]}`}
                      </ButtonLink>
                    ) : null
                  }
                  className="border-t border-line"
                />
              )}
            </Card>
          );
        })}

        {!inPlan ? (
          <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
            {SEGMENTS_NOT_IN_PLAN}
          </p>
        ) : writer ? (
          <Card aria-labelledby="segment-new">
            <CardHeader id="segment-new" title="רשימה ידנית חדשה" />
            <CardBody>
              <NewStaticSegmentForm orgId={orgId} />
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
