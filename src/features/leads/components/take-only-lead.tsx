import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getTimeline } from "@/features/activities/queries";
import { isPinnableType } from "@/features/activities/schema";
import { NoteText } from "@/features/activities/components/note-text";
import { listActivityTypes } from "@/features/activity-types/queries";
import { formatBytes } from "@/features/files/types";
import { byGender, withPrefixThe, type OrgTerms } from "@/features/terminology/terms";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";

import { leadDisplayName, statusTone } from "../display";
import { getUnownedLeadTimeline, type LeadSourceOption, type LeadStatusOption, type UnownedLead } from "../queries";
import { TakeLeadButton } from "./take-lead-button";

type Props = {
  orgId: string;
  lead: UnownedLead;
  statuses: LeadStatusOption[];
  sources: LeadSourceOption[];
  terms: OrgTerms;
  canWrite: boolean;
};

/**
 * SPD-01 (owner, 9 and 10 November 2026, (187) ב and (212) ב): a lead nobody owns that this person is offered to take
 * but does not read under the business's record visibility. They read it and its timeline (no private notes; files by
 * name only) and press "לקחתי"; nothing else until it is theirs. Everything here comes from public.unowned_lead and
 * public.unowned_lead_timeline.
 */
export async function TakeOnlyLead({ orgId, lead, statuses, sources, terms, canWrite }: Props) {
  const name = leadDisplayName({ fullName: lead.full_name, email: lead.email, phone: lead.phone });
  const status = statuses.find((option) => option.id === lead.status_id);
  const sourceName = lead.source_id ? (sources.find((source) => source.id === lead.source_id)?.name ?? null) : null;
  const [timeline, types] = await Promise.all([getUnownedLeadTimeline(orgId, lead.id), listActivityTypes(orgId)]);
  const subject = { kind: "lead" as const, id: lead.id };
  const items = timeline ? await getTimeline(orgId, subject, undefined, types, terms, timeline.activities) : [];
  const files = timeline?.files ?? [];
  const filesByEntry = new Map<string, typeof files>();
  for (const file of files) {
    if (file.activity_id) filesByEntry.set(file.activity_id, [...(filesByEntry.get(file.activity_id) ?? []), file]);
  }
  const leadFiles = files.filter((file) => file.activity_id === null);

  const details: Array<{ label: string; value: string | null; ltr?: boolean }> = [
    { label: "טלפון", value: lead.phone, ltr: true },
    { label: "אימייל", value: lead.email, ltr: true },
    { label: "חברה", value: lead.company_name },
    { label: "מקור", value: sourceName },
    { label: "נכנס", value: formatDateTime(lead.created_at) },
    { label: "תאריך יצירה במערכת הקודמת", value: lead.original_created_on ? formatDate(lead.original_created_on) : null },
    { label: "מגע אחרון", value: lead.last_contacted_at ? formatDateTime(lead.last_contacted_at) : null },
  ];

  return (
    <>
      <PageHeader
        title={name}
        back={{ href: paths.leadsWaiting(orgId), label: "לידים שמחכים" }}
        actions={<Badge tone={statusTone(status)}>{status?.name ?? "ללא סטטוס"}</Badge>}
      />
      <div className="mb-5 flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-md">{`כדי לטפל ${withPrefixThe("ב", terms.lead)}, קחו ${byGender(terms.lead, "אותו", "אותה")} קודם`}</p>
        {canWrite ? <TakeLeadButton orgId={orgId} leadId={lead.id} leadName={name} size="sm" className="sm:items-end" /> : null}
      </div>
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card aria-labelledby="take-only-timeline" className="order-2 lg:order-1">
          <CardHeader id="take-only-timeline" title="ציר זמן" />
          <CardBody>
            {items.length === 0 ? (
              <p className="text-md text-ink-soft">עוד אין כאן פעילות.</p>
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
                    <p className="min-w-0 text-sm text-ink-soft">
                      {item.pinned ? <Badge tone="accent" className="me-2">נעוץ</Badge> : null}
                      <span className="font-medium text-ink">{item.label}</span>
                      {item.authorName ? <>, {item.authorName}</> : null}
                      <span className="mx-1.5" aria-hidden="true">
                        |
                      </span>
                      <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
                    </p>
                    {item.text && isPinnableType(item.type) ? (
                      <NoteText text={item.text} className="mt-1" />
                    ) : item.text ? (
                      <p className={cn("mt-1 break-words whitespace-pre-wrap", !item.isUserContent && "text-ink-soft")}>{item.text}</p>
                    ) : null}
                    {filesByEntry.get(item.id)?.length ? (
                      <ul className="mt-1.5 flex flex-wrap gap-2 text-sm" aria-label="קבצים מצורפים">
                        {filesByEntry.get(item.id)!.map((file) => (
                          <li key={file.id} className="rounded-md border border-line px-2 py-1">
                            <span className="break-all">{file.name}</span> <span className="text-ink-soft">{formatBytes(file.size_bytes)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
        <div className="order-1 space-y-5 lg:order-2">
          <Card aria-labelledby="take-only-details">
            <CardHeader id="take-only-details" title="פרטים" />
            <CardBody>
              <dl className="space-y-3 text-sm">
                {details
                  .filter((row) => row.value)
                  .map((row) => (
                    <div key={row.label}>
                      <dt className="text-ink-soft">{row.label}</dt>
                      <dd className="break-words" dir={row.ltr ? "ltr" : undefined}>
                        {row.ltr ? <span className="inline-block text-start">{row.value}</span> : row.value}
                      </dd>
                    </div>
                  ))}
                {lead.message ? (
                  <div>
                    <dt className="text-ink-soft">הודעה</dt>
                    <dd className="whitespace-pre-line break-words">{lead.message}</dd>
                  </div>
                ) : null}
              </dl>
            </CardBody>
          </Card>
          {leadFiles.length > 0 ? (
            <Card aria-labelledby="take-only-files">
              <CardHeader id="take-only-files" title="קבצים" />
              <CardBody>
                <ul className="space-y-1.5 text-sm">
                  {leadFiles.map((file) => (
                    <li key={file.id}>
                      <span className="break-all">{file.name}</span> <span className="text-ink-soft">{formatBytes(file.size_bytes)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-sm text-ink-soft">אפשר לפתוח את הקבצים אחרי שלוקחים את הליד.</p>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
