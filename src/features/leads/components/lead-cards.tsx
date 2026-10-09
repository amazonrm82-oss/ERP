import Link from "next/link";

import { ContactActions } from "@/components/contact-actions";
import { Badge } from "@/components/ui/badge";
import { paths } from "@/lib/paths";

import { leadDisplayName, statusTone } from "../display";
import type { LeadListItem, LeadStatusOption } from "../queries";

type Props = { orgId: string; leads: LeadListItem[]; statuses: LeadStatusOption[]; className?: string };

/**
 * Leads on a phone (FXU-02): a card per lead with name, status and owner, and
 * call / WhatsApp in one tap. The table stays for wider screens.
 */
export function LeadCards({ orgId, leads, statuses, className }: Props) {
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  return (
    <ul aria-label="לידים" className={className}>
      {leads.map((lead) => {
        const status = statusById.get(lead.statusId);
        const name = leadDisplayName(lead);
        return (
          <li key={lead.id} className="mb-2 flex items-center gap-3 rounded-lg border border-line bg-surface py-2.5 ps-4 pe-2.5">
            <Link href={paths.lead(orgId, lead.id)} className="min-w-0 flex-1 py-1">
              <span className="block truncate font-medium text-ink">{name}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft">
                {status ? <Badge tone={statusTone(status)}>{status.name}</Badge> : null}
                {lead.companyName ? <span className="truncate">{lead.companyName}</span> : null}
                {lead.ownerName ? <span className="truncate">אחראי: {lead.ownerName}</span> : null}
              </span>
            </Link>
            <ContactActions phone={lead.phone} phoneE164={lead.phoneE164} email={null} compact={{ name }} />
          </li>
        );
      })}
    </ul>
  );
}
