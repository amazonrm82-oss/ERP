import type { Metadata } from "next";
import Link from "next/link";

import { ContactActions } from "@/components/contact-actions";
import { EmptyState } from "@/components/ui/feedback";
import { InboxIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { UniqueClashNote } from "@/features/data-quality/components/unique-clash-note";
import { findUniqueFieldClashes, type UniqueClash } from "@/features/data-quality/duplicates";
import { TakeLeadButton } from "@/features/leads/components/take-lead-button";
import { WaitingClock } from "@/features/leads/components/waiting-clock";
import { takenLabel } from "@/features/leads/take";
import { getWaitingLeads } from "@/features/leads/waiting";
import { getOrgTerms } from "@/features/terminology/queries";
import { byGender, waitingPlural } from "@/features/terminology/terms";
import { getOrgContext } from "@/features/shell/queries";
import { formatDateTime, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";
import { waitingText } from "@/lib/waiting-time";

export async function generateMetadata({ params }: { params: Promise<{ orgId: string }> }): Promise<Metadata> {
  // FLD-10: the business's own word
  return { title: waitingPlural((await getOrgTerms((await params).orgId)).lead) };
}

type Props = { params: Promise<{ orgId: string }>; searchParams: Promise<{ who?: string | string[] }> };

/**
 * Leads no one has answered yet (SPD-02), the one waiting longest first, each
 * with a clock from the moment it came in and one-tap call and WhatsApp.
 */
export default async function WaitingLeadsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  // FLD-10: the business's own word
  const term = (await getOrgTerms(orgId)).lead;
  const showAll = (await searchParams).who === "all";
  const { leads, truncated } = showAll
    ? await getWaitingLeads(orgId, null, { id: context.user.id, role: context.role })
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
            <li key={lead.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1">
                <Link href={paths.lead(orgId, lead.id)} className="block break-words font-medium underline-offset-4 hover:underline">
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
    </>
  );
}
