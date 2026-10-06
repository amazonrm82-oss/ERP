import type { BadgeTone } from "@/components/ui/badge";
import type { LeadStatusKind } from "@/lib/database.types";

/** What to call a lead on screen when it has no name. */
export function leadDisplayName(lead: { fullName: string | null; email: string | null; phone: string | null }): string {
  return lead.fullName || lead.email || lead.phone || "ליד ללא שם";
}

/** Badge colour of a lead status: new leads stand out, closed ones recede. */
export function statusTone(status: { kind: LeadStatusKind; isDefault: boolean } | undefined): BadgeTone {
  if (!status) {
    return "neutral";
  }
  if (status.kind === "converted") {
    return "success";
  }
  if (status.kind === "disqualified") {
    return "neutral";
  }
  return status.isDefault ? "accent" : "warning";
}
