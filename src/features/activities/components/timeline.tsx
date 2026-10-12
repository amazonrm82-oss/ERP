import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { getOrgContext } from "@/features/shell/queries";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { recordPage } from "@/lib/record-types";

import { getTimeline } from "../queries";
import { canPinHint, isPinnableType, parseTimelineFilter, TIMELINE_FILTERS, timelineFilterHref, type TimelineSubject } from "../schema";
import { NoteForm } from "./note-form";
import { NoteText } from "./note-text";
import { PinButton } from "./pin-button";

type Props = {
  orgId: string;
  subject: TimelineSubject;
  canWrite: boolean;
  // REC-06: the `tl` value of the page's URL, checked here
  filter?: string | string[];
};

/**
 * Timeline card of a record: add-note form on top, a filter by kind of activity (REC-06),
 * then pinned entries (REC-01), then the rest, newest first.
 */
export async function Timeline({ orgId, subject, canWrite, filter: filterParam }: Props) {
  const filter = parseTimelineFilter(filterParam);
  // getOrgContext is memoized per request: the page already loaded it
  const [items, context] = await Promise.all([getTimeline(orgId, subject, filter), getOrgContext(orgId)]);
  const recordHref = recordPage(subject.kind, orgId, subject.id);
  const viewer = { userId: context.user.id, role: context.role, canWrite: canWrite && context.canWrite };

  return (
    <Card aria-labelledby="timeline-title">
      <CardHeader id="timeline-title" title="ציר זמן" />
      <CardBody>
        {canWrite ? (
          <div className="mb-6">
            <NoteForm orgId={orgId} subject={subject} />
          </div>
        ) : null}

        <Tabs
          label="סינון ציר הזמן לפי סוג"
          className="mb-5"
          items={TIMELINE_FILTERS.map((option) => ({
            href: timelineFilterHref(recordHref, option.key),
            label: option.label,
            current: option.key === filter.key,
          }))}
        />

        {items.length === 0 ? (
          <p className="text-md text-ink-soft">
            {filter.key === "all"
              ? "עוד אין כאן פעילות. הערות, שינויי סטטוס והמרות יופיעו כאן לפי הסדר."
              : "אין כאן פעילות מהסוג הזה."}
          </p>
        ) : (
          <ol className="space-y-5">
            {items.map((item) => (
              <li key={item.id} className={cn("relative", item.pinned ? "rounded-md bg-canvas p-3 ps-8" : "ps-5")}>
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute size-2 rounded-full",
                    item.pinned ? "start-3 top-[1.3125rem]" : "start-0 top-[0.5625rem]",
                    item.isUserContent ? "bg-accent" : "bg-line-strong",
                  )}
                />
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-sm text-ink-soft">
                    {item.pinned ? <Badge tone="accent" className="me-2">נעוץ</Badge> : null}
                    <span className="font-medium text-ink">{item.label}</span>
                    {item.authorName ? <>, {item.authorName}</> : null}
                    <span className="mx-1.5" aria-hidden="true">
                      |
                    </span>
                    <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
                  </p>
                  {canPinHint(item, viewer) ? (
                    <PinButton orgId={orgId} subject={subject} activityId={item.id} pinned={item.pinned} label={item.label} />
                  ) : null}
                </div>
                {item.text && isPinnableType(item.type) ? (
                  // REC-04: what a person logged may carry basic formatting
                  <NoteText text={item.text} className="mt-1" />
                ) : item.text ? (
                  <p className={cn("mt-1 break-words whitespace-pre-wrap", !item.isUserContent && "text-ink-soft")}>
                    {item.text}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}
