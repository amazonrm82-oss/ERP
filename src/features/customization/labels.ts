import type { LeadStatusKind, StageKind } from "@/lib/database.types";

export const STAGE_KIND_LABELS: Record<StageKind, string> = { open: "פתוח", won: "נסגר בהצלחה", lost: "אבוד" };

export const STATUS_KIND_LABELS: Record<LeadStatusKind, string> = { open: "פתוח", converted: "הומר", disqualified: "לא רלוונטי" };
