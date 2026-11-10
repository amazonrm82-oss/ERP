import { RecordCards } from "@/components/record-cards";
import { Badge } from "@/components/ui/badge";
import { listWhatsappLog, type WhatsappListContext } from "@/features/whatsapp/templates";
import { paths } from "@/lib/paths";
import { fullDateTimeText, relativeTimeText } from "@/lib/relative-time";

import { leadDisplayName, statusTone } from "../display";
import type { LeadListItem, LeadStatusOption } from "../queries";
import { takeOffered } from "../take";
import { TakeLeadButton } from "./take-lead-button";

// showScore: the user shows the score column on a computer, so the phone card shows it too (LEAD-05)
type Props = {
  orgId: string;
  leads: LeadListItem[];
  statuses: LeadStatusOption[];
  showScore?: boolean;
  className?: string;
  // WA-01 follow-up: null for someone who cannot write
  whatsapp?: WhatsappListContext | null;
  // SPD-01: whether the viewer writes in the business, so a lead nobody owns offers "לקחתי"
  canWrite?: boolean;
  // UX-01: a card opens the side panel (?peek=<id>) instead of the full page
  hrefFor?: (id: string) => string;
  // "מגע אחרון" reads as a relative time ("לפני 3 שעות") in the business's zone, measured from this moment
  timeZone?: string;
  now?: Date;
};

/** Leads on a phone (FXU-02): name, status, company and owner, with call / WhatsApp. */
export function LeadCards({ orgId, leads, statuses, showScore, className, whatsapp = null, canWrite = false, hrefFor, timeZone, now }: Props) {
  const at = now ?? new Date();
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  return (
    <RecordCards
      label="לידים"
      className={className}
      cards={leads.map((lead) => {
        const status = statusById.get(lead.statusId);
        return {
          id: lead.id,
          href: hrefFor ? hrefFor(lead.id) : paths.lead(orgId, lead.id),
          title: leadDisplayName(lead),
          badge: status ? <Badge tone={statusTone(status)}>{status.name}</Badge> : null,
          details: [
            lead.companyName,
            lead.ownerName ? `אחראי: ${lead.ownerName}` : null,
            lead.lastContactedAt
              ? { text: `מגע אחרון: ${relativeTimeText(lead.lastContactedAt, at, timeZone)}`, title: fullDateTimeText(lead.lastContactedAt, timeZone) }
              : null,
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
          action: takeOffered({ ownerId: lead.ownerId, statusKind: status?.kind }, canWrite) ? (
            <TakeLeadButton orgId={orgId} leadId={lead.id} leadName={leadDisplayName(lead)} size="sm" />
          ) : undefined,
        };
      })}
    />
  );
}
