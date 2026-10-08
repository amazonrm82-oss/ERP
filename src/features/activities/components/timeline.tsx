import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";

import { getTimeline } from "../queries";
import type { TimelineSubject } from "../schema";
import { NoteForm } from "./note-form";

type Props = { orgId: string; subject: TimelineSubject; canWrite: boolean };

/** Timeline card of a record: add-note form on top, then activities, newest first. */
export async function Timeline({ orgId, subject, canWrite }: Props) {
  const items = await getTimeline(orgId, subject);

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
              <li key={item.id} className="relative ps-5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute start-0 top-[0.5625rem] size-2 rounded-full",
                    item.isUserContent ? "bg-accent" : "bg-line-strong",
                  )}
                />
                <p className="text-sm text-ink-soft">
                  <span className="font-medium text-ink">{item.label}</span>
                  {item.authorName ? <>, {item.authorName}</> : null}
                  <span className="mx-1.5" aria-hidden="true">
                    |
                  </span>
                  <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
                </p>
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
