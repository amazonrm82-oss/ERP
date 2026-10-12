import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { LockIcon } from "@/components/ui/icons";
import { Tabs } from "@/components/ui/tabs";
import { getOrgContext } from "@/features/shell/queries";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { recordPage } from "@/lib/record-types";

import { getTimeline, managesRecordTeam } from "../queries";
import { canEditNoteHint, canPinHint, isPinnableType, parseTimelineFilter, TIMELINE_FILTERS, timelineFilterHref, type TimelineSubject } from "../schema";
import { NoteActions } from "./note-actions";
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
  // REC-01: a team manager pins (only pins) the entries on their team's records
  const managesRecord = context.role === "manager" ? await managesRecordTeam(orgId, subject, context.user.id) : false;
  const recordHref = recordPage(subject.kind, orgId, subject.id);
  // one clock for the whole list, read once per request on the server: who may still edit what (REC-05)
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const viewer = { userId: context.user.id, role: context.role, canWrite: canWrite && context.canWrite, managesRecordTeam: managesRecord };

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
                <div>
                  <p className="min-w-0 text-sm text-ink-soft">
                    {item.pinned ? <Badge tone="accent" className="me-2">נעוץ</Badge> : null}
                    {item.isPrivate ? (
                      // GAP-05: only the author and the owners/admins see this entry
                      <Badge tone="warning" className="me-2 gap-1">
                        <LockIcon className="size-3.5" />
                        פרטית
                        <span className="sr-only">: גלויה רק למי שכתב אותה ולמנהלי המערכת</span>
                      </Badge>
                    ) : null}
                    <span className="font-medium text-ink">{item.label}</span>
                    {item.authorName ? <>, {item.authorName}</> : null}
                    <span className="mx-1.5" aria-hidden="true">
                      |
                    </span>
                    <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
                  </p>
                </div>
                {item.text && isPinnableType(item.type) ? (
                  // REC-04: what a person logged may carry basic formatting
                  <NoteText text={item.text} className="mt-1" />
                ) : item.text ? (
                  <p className={cn("mt-1 break-words whitespace-pre-wrap", !item.isUserContent && "text-ink-soft")}>
                    {item.text}
                  </p>
                ) : null}
                {canPinHint(item, viewer) ? (
                  // REC-01 pin: the author at any time, and a manager of the record's team; REC-05 edit
                  // and delete: the author for 24 hours. Owners and admins: everything, always.
                  <div className="mt-1 -ms-3 flex flex-wrap items-start gap-1">
                    <PinButton orgId={orgId} subject={subject} activityId={item.id} pinned={item.pinned} label={item.label} />
                    {canEditNoteHint(item, viewer, now) ? (
                      <NoteActions
                        orgId={orgId}
                        subject={subject}
                        activityId={item.id}
                        label={item.label}
                        body={item.body}
                        type={item.type}
                        isPrivate={item.isPrivate}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}
