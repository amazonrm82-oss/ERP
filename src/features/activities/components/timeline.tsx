import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { LockIcon } from "@/components/ui/icons";
import { Tabs } from "@/components/ui/tabs";
import { TypeIcon } from "@/features/activity-types/components/type-icon";
import { listActivityTypes } from "@/features/activity-types/queries";
import { logChoices } from "@/features/activity-types/types";
import { listNoteFiles } from "@/features/files/queries";
import { formatBytes, opensInBrowser } from "@/features/files/types";
import { getMentionCandidates } from "@/features/mentions/queries";
import { mentionIds } from "@/features/mentions/token";
import { printsTimelineEntry } from "@/features/print/print";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { recordPage } from "@/lib/record-types";

import { getTimeline, managesRecordTeam } from "../queries";
import { canEditNoteHint, canPinHint, canRemoveImportNoteHint, isPinnableType, parseTimelineFilter, TIMELINE_FILTERS, timelineFilterHref, type TimelineSubject } from "../schema";
import { ImportNoteRemove, NoteActions } from "./note-actions";
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
  // TASK-08: the business's activity types name the entries and fill the log form's choices
  const typesRead = listActivityTypes(orgId);
  // FLD-10 part three: the entries the app draws (a conversion, a stage move, a lead passed on) in the business's words
  const termsRead = getOrgTerms(orgId);
  const [items, context, types] = await Promise.all([
    Promise.all([typesRead, termsRead]).then(([list, terms]) => getTimeline(orgId, subject, filter, list, terms)),
    getOrgContext(orgId),
    typesRead,
  ]);
  const writable = canWrite && context.canWrite;
  // REC-02: who may be mentioned here, and the current names of those mentioned in the entries shown
  const [mentions, mentionedNames, noteFiles] = await Promise.all([
    writable ? getMentionCandidates(orgId, subject) : Promise.resolve(undefined),
    getUserNames(items.filter((item) => isPinnableType(item.type)).flatMap((item) => mentionIds(item.body))),
    // REC-07: files attached to the entries shown (RLS: only entries the user sees)
    listNoteFiles(orgId, items.filter((item) => isPinnableType(item.type)).map((item) => item.id)),
  ]);
  const names = Object.fromEntries(mentionedNames);
  // REC-01: a team manager pins (only pins) the entries on their team's records
  const managesRecord = context.role === "manager" ? await managesRecordTeam(orgId, subject, context.user.id) : false;
  const recordHref = recordPage(subject.kind, orgId, subject.id);
  // one clock for the whole list, read once per request on the server: who may still edit what (REC-05)
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const viewer = { userId: context.user.id, role: context.role, canWrite: writable, managesRecordTeam: managesRecord };

  return (
    <Card aria-labelledby="timeline-title">
      <CardHeader id="timeline-title" title="ציר זמן" />
      <CardBody>
        {canWrite ? (
          <div className="mb-6 print:hidden">
            <NoteForm orgId={orgId} subject={subject} mentions={mentions} choices={logChoices(types)} />
          </div>
        ) : null}

        <Tabs
          label="סינון ציר הזמן לפי סוג"
          className="mb-5 print:hidden"
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
              <li
                key={item.id}
                // GAP-11: someone else's private note stays off paper, even for owners/admins who see it here
                className={cn("relative", item.pinned ? "rounded-md bg-canvas p-3 ps-8" : "ps-5", !printsTimelineEntry(item, context.user.id) && "print:hidden")}
              >
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
                    {item.icon ? <TypeIcon icon={item.icon} className="me-1 inline size-4 align-text-bottom text-ink-soft" /> : null}
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
                  <NoteText text={item.text} names={names} className="mt-1" />
                ) : item.text ? (
                  <p className={cn("mt-1 break-words whitespace-pre-wrap", !item.isUserContent && "text-ink-soft")}>
                    {item.text}
                  </p>
                ) : null}
                {noteFiles.get(item.id)?.length ? (
                  <ul className="mt-1.5 flex flex-wrap gap-2" aria-label="קבצים מצורפים">
                    {noteFiles.get(item.id)!.map((file) => {
                      const viewable = opensInBrowser(file.mimeType);
                      return (
                        <li key={file.id}>
                          <a
                            href={`${paths.file(orgId, file.id)}${viewable ? "?view=1" : ""}`}
                            target={viewable ? "_blank" : undefined}
                            rel="noopener"
                            className="inline-flex max-w-full items-center gap-1 rounded-md border border-line px-2 py-1 text-sm text-accent-strong underline-offset-4 hover:underline print:border-0 print:p-0 print:text-ink"
                          >
                            <span className="truncate">{file.name}</span>
                            <span className="shrink-0 text-ink-soft">
                              {formatBytes(file.sizeBytes)}
                              {file.versions > 1 ? ` · גרסה ${file.versions}` : ""}
                            </span>
                            {viewable ? <span className="sr-only"> (נפתח בחלון חדש)</span> : null}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
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
                        mentions={mentions}
                      />
                    ) : null}
                  </div>
                ) : null}
                {canRemoveImportNoteHint(item, viewer) ? (
                  // GAP-12: a wrong note from an import; owners and admins only (the activities_delete policy)
                  <div className="mt-1 -ms-3 flex flex-wrap items-start gap-1">
                    <ImportNoteRemove orgId={orgId} subject={subject} activityId={item.id} label={item.label} />
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
