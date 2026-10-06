import type { BadgeTone } from "@/components/ui/badge";
import type { StageKind } from "@/lib/database.types";

export const DEAL_STATUS: Record<StageKind, { label: string; tone: BadgeTone }> = {
  open: { label: "פתוחה", tone: "accent" },
  won: { label: "נסגרה בהצלחה", tone: "success" },
  lost: { label: "אבודה", tone: "neutral" },
};
