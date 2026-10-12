import { RecordCards } from "@/components/record-cards";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/paths";

import { leadDisplayName, statusTone } from "../display";
import type { LeadListItem, LeadStatusOption } from "../queries";

type Props = { orgId: string; leads: LeadListItem[]; statuses: LeadStatusOption[]; className?: string };

/** Leads on a phone (FXU-02): name, status, company and owner, with call / WhatsApp. */
export function LeadCards({ orgId, leads, statuses, className }: Props) {
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  return (
    <RecordCards
      label="לידים"
      className={className}
      cards={leads.map((lead) => {
        const status = statusById.get(lead.statusId);
        return {
          id: lead.id,
          href: paths.lead(orgId, lead.id),
          title: leadDisplayName(lead),
          badge: status ? <Badge tone={statusTone(status)}>{status.name}</Badge> : null,
          details: [
            lead.companyName,
            lead.ownerName ? `אחראי: ${lead.ownerName}` : null,
            lead.lastContactedAt ? `מגע אחרון: ${formatDate(lead.lastContactedAt)}` : null,
          ],
          phone: lead.phone,
          phoneE164: lead.phoneE164,
        };
      })}
    />
  );
}
