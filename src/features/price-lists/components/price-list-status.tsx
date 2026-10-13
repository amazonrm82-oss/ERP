import { Badge, type BadgeTone } from "@/components/ui/badge";

import { PRICE_LIST_STATUS_LABELS, priceListStatus, type PriceListTerms, type PriceListStatus } from "../status";

const TONES: Record<PriceListStatus, BadgeTone> = { in_force: "success", inactive: "neutral", upcoming: "accent", ended: "warning" };

/** "בתוקף", "לא פעיל", "עוד לא בתוקף" or "התוקף הסתיים" on the organization's today. */
export function PriceListStatusBadge({ list, today }: { list: PriceListTerms; today: string }) {
  const status = priceListStatus(list, today);
  return <Badge tone={TONES[status]}>{PRICE_LIST_STATUS_LABELS[status]}</Badge>;
}
