import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { getOrgContext } from "@/features/shell/queries";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";

import { getTimeline } from "../queries";
import { canPinHint, type TimelineSubject } from "../schema";
import { NoteForm } from "./note-form";
import { PinButton } from "./pin-button";

type Props = { orgId: string; subject: TimelineSubject; canWrite: boolean };

/** Timeline card of a record: add-note form on top, then pinned entries (REC-01), then the rest, newest first. */
export async function Timeline({ orgId, subject, canWrite }: Props) {
  // getOrgContext is memoized per request: the page already loaded it
  const [items, context] = await Promise.all([getTimeline(orgId, subject), getOrgContext(orgId)]);
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

        {items.length === 0 ? (
          <p className="text-md text-ink-soft">
            עוד אין כאן פעילות. הערות, שינויי סטטוס והמרות יופיעו כאן לפי הסדר.
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
                {item.text ? (
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
