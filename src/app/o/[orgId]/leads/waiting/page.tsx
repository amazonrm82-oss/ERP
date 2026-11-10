import type { Metadata } from "next";
import Link from "next/link";

import { ContactActions } from "@/components/contact-actions";
import { EmptyState } from "@/components/ui/feedback";
import { InboxIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { buttonClasses } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { UniqueClashNote } from "@/features/data-quality/components/unique-clash-note";
import { findUniqueFieldClashes, type UniqueClash } from "@/features/data-quality/duplicates";
import { TakeLeadButton } from "@/features/leads/components/take-lead-button";
import { WaitingClock } from "@/features/leads/components/waiting-clock";
import { LeadPeek } from "@/features/lead-peek/components/lead-peek";
import { QueueEndPanel } from "@/features/lead-peek/components/queue-end-panel";
import { PEEK_ROW_MARK, peekLinks } from "@/features/lead-peek/model";
import { QueueMemory } from "@/features/lead-peek/components/queue-memory";
import { queueHref, queueLeft, queueState } from "@/features/lead-peek/queue";
import { ToastProvider } from "@/components/ui/toast";
import { takenLabel } from "@/features/leads/take";
import { getWaitingLeads } from "@/features/leads/waiting";
import { getOrgTerms } from "@/features/terminology/queries";
import { byGender, waitingPlural } from "@/features/terminology/terms";
import { getOrgContext } from "@/features/shell/queries";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";
import { waitingText } from "@/lib/waiting-time";

export async function generateMetadata({ params }: { params: Promise<{ orgId: string }> }): Promise<Metadata> {
  // FLD-10: the business's own word
  return { title: waitingPlural((await getOrgTerms((await params).orgId)).lead) };
}

type Props = { params: Promise<{ orgId: string }>; searchParams: Promise<{ who?: string | string[]; peek?: string | string[]; queue?: string | string[] }> };

/**
 * Leads no one has answered yet (SPD-02), the one waiting longest first, each
 * with a clock from the moment it came in and one-tap call and WhatsApp.
 */
export default async function WaitingLeadsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  // FLD-10: the business's own word
  const term = (await getOrgTerms(orgId)).lead;
  const query = await searchParams;
  const showAll = query.who === "all";
  const { leads, truncated } = showAll
    ? // SPD-01 (lead's interim choice): the leads nobody owns that this person may take show on this tab only
      await getWaitingLeads(orgId, null, { id: context.user.id, role: context.role }, { offered: true })
    : await getWaitingLeads(orgId, context.user.id);
  // FLD-07: a lead from a public form whose unique field holds a value another record holds
  const clashes = new Map<string, UniqueClash[]>();
  for (const clash of await findUniqueFieldClashes(await createClient(), orgId, "lead", leads.map((lead) => lead.id))) {
    clashes.set(clash.recordId, [...(clashes.get(clash.recordId) ?? []), clash]);
  }
  // read once per request on the server; the clocks run on in the browser
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const base = paths.leadsWaiting(orgId);
  // UX-01: a lead's name opens the side panel (?peek=); the open lead's name opens its full page
  const peek = peekLinks(orgId, base, query);
  // UX-02 "מצב תור" (lead's choice of UI): a button opens the oldest waiting lead in the panel with ?queue=1; after an
  // action there the next one opens, in this list's order; at the end the panel says so (?queue=end)
  const queue = context.canWrite ? queueState(query) : null;
  const firstId = leads[0]?.id ?? null;
  const exitHref = queueHref(base, peek.params, "off", peek.peekId);

  return (
    <>
      <PageHeader
        title={waitingPlural(term)}
        description={
          leads.length > 0
            ? `${formatNumber(leads.length)}${truncated ? "+" : ""} ${term.plural} עוד לא קיבלו מענה. ${byGender(term, "הוותיק ביותר", "הוותיקה ביותר")} למעלה.`
            : undefined
        }
        back={{ href: paths.leads(orgId), label: term.plural }}
      />
      <Tabs
        label={`של מי ${term.thePlural}`}
        className="mb-5"
        items={[
          { href: base, label: "שלי", current: !showAll },
          { href: `${base}?who=all`, label: "כל מה שאני רואה", current: showAll },
        ]}
      />
      {queue === null && context.canWrite && firstId ? (
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link href={queueHref(base, peek.params, "on", firstId)} scroll={false} className={buttonClasses("secondary", "md")} aria-describedby="queue-hint">
            מצב תור
          </Link>
          <p id="queue-hint" className="text-sm text-ink-soft">
            {`אחרי כל פעולה בפאנל ${byGender(term, "נפתח", "נפתחת")} ${term.theSingular} ${byGender(term, "הבא", "הבאה")}.`}
          </p>
        </div>
      ) : null}
      {queue !== null ? (
        <div role="region" aria-label="מצב תור" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-accent-soft px-4 py-3">
          <p className="text-md text-accent-strong">
            {`מצב תור פעיל: אחרי כל פעולה בפאנל ${byGender(term, "נפתח", "נפתחת")} ${term.theSingular} ${byGender(term, "הבא", "הבאה")}.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {!peek.peekId && queue === "on" && firstId ? (
              <Link href={queueHref(base, peek.params, "on", firstId)} scroll={false} className={buttonClasses("primary", "sm")}>
                להמשיך בתור
              </Link>
            ) : null}
            <Link href={exitHref} scroll={false} className={buttonClasses("secondary", "sm")}>
              יציאה ממצב תור
            </Link>
          </div>
        </div>
      ) : null}
      {leads.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            icon={<InboxIcon />}
            title={`אין ${waitingPlural(term)}`}
            description={`כל ${term.singular} ${byGender(term, "שנכנס ועוד לא קיבל", "שנכנסה ועוד לא קיבלה")} מענה (שיחה, הודעה, פגישה או הערה בציר הזמן) ${byGender(term, "מופיע", "מופיעה")} כאן, עם הזמן שעבר מאז ${byGender(term, "שנכנס", "שנכנסה")}.`}
          />
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {leads.map((lead) => (
            <li key={lead.id} className={cn("flex items-center gap-3 px-4 py-3 sm:px-5", peek.peekId === lead.id && PEEK_ROW_MARK)}>
              <div className="min-w-0 flex-1">
                <Link
                  href={peek.hrefFor(lead.id)}
                  scroll={false}
                  aria-current={peek.peekId === lead.id ? "true" : undefined}
                  className="block break-words font-medium underline-offset-4 hover:underline"
                >
                  <bdi>{lead.name}</bdi>
                </Link>
                <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-ink-soft">
                  <span className="font-medium text-warning">
                    ממתין <WaitingClock since={lead.createdAt} initial={waitingText(now - Date.parse(lead.createdAt))} />
                  </span>
                  <span>נכנס {formatDateTime(lead.createdAt)}</span>
                  {lead.sourceName ? <span>{lead.sourceName}</span> : null}
                  {lead.companyName ? <bdi>{lead.companyName}</bdi> : null}
                  {takenLabel(lead, context.user.id) ? (
                    <span className="font-medium text-ink">{takenLabel(lead, context.user.id)}</span>
                  ) : showAll ? (
                    <span>{lead.ownerName ? `אחראי: ${lead.ownerName}` : "ללא אחראי"}</span>
                  ) : null}
                </p>
                {clashes.get(lead.id)?.map((clash) => (
                  <p key={`${clash.label}-${clash.other?.href ?? ""}`} className="mt-0.5 text-sm">
                    <UniqueClashNote clash={clash} />
                  </p>
                ))}
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {/* SPD-01: a lead nobody has goes to the first one who takes it */}
                {context.canWrite && lead.ownerId === null ? <TakeLeadButton orgId={orgId} leadId={lead.id} leadName={lead.name} size="sm" /> : null}
                <ContactActions phone={lead.phone} phoneE164={lead.phoneE164} email={null} compact={{ name: lead.name }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {truncated ? <p className="mt-3 text-sm text-ink-soft">מוצגים 200 הלידים הוותיקים שמחכים.</p> : null}
      {queue !== null ? (
        // owner (237) ב: a saved task in the queue says so in a toast too
        <ToastProvider>
          <LeadPeek orgId={orgId} context={context} links={peek} listIds={leads.map((lead) => lead.id)} listPath={base} queue />
          {queue === "end" && !peek.peekId ? (
            <QueueEndPanel
              title="סוף התור"
              text={
                firstId
                  ? `עברתם על כל ${term.thePlural} בתור. ${formatNumber(leads.length)}${truncated ? "+" : ""} ${term.plural} עוד ${byGender(term, "מחכים", "מחכות")} למענה.`
                  : `אין עוד ${waitingPlural(term)}.`
              }
              restartHref={firstId ? queueHref(base, peek.params, "on", firstId) : null}
              restartLabel="מההתחלה"
              exitHref={queueHref(base, peek.params, "off", null)}
            />
          ) : null}
        </ToastProvider>
      ) : (
        <LeadPeek orgId={orgId} context={context} links={peek} listIds={leads.map((lead) => lead.id)} listPath={base} />
      )}
      {/* owner (238) א: the choice is remembered on this device; opening this screen again resumes the queue */}
      <QueueMemory
        orgId={orgId}
        userId={context.user.id}
        canWrite={context.canWrite}
        state={queue}
        left={queueLeft(query)}
        resumeHref={firstId ? queueHref(base, peek.params, "on", peek.peekId ?? firstId) : null}
      />
    </>
  );
}
