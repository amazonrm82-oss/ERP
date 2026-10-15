import { RecordCards } from "@/components/record-cards";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { listWhatsappLog, type WhatsappListContext } from "@/features/whatsapp/templates";
import { paths } from "@/lib/paths";

import { leadDisplayName, statusTone } from "../display";
import type { LeadListItem, LeadStatusOption } from "../queries";

// showScore: the user shows the score column on a computer, so the phone card shows it too (LEAD-05)
type Props = {
  orgId: string;
  leads: LeadListItem[];
  statuses: LeadStatusOption[];
  showScore?: boolean;
  className?: string;
  // WA-01 follow-up: null for someone who cannot write
  whatsapp?: WhatsappListContext | null;
};

/** Leads on a phone (FXU-02): name, status, company and owner, with call / WhatsApp. */
export function LeadCards({ orgId, leads, statuses, showScore, className, whatsapp = null }: Props) {
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
            showScore && lead.score !== undefined ? `ציון: ${lead.score}` : null,
          ],
          phone: lead.phone,
          phoneE164: lead.phoneE164,
          whatsappLog: listWhatsappLog(whatsapp, {
            subject: { kind: "lead", id: lead.id },
            name: leadDisplayName(lead),
            phoneE164: lead.phoneE164,
            fullName: lead.fullName,
          }),
        };
      })}
    />
  );
}
