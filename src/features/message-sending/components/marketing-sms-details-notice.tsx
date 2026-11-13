import { TextLink } from "@/components/ui/text-link";
import { documentSettingsPath } from "@/features/tax/paths";

import { marketingSmsMissingText, type MarketingDetailMissing } from "../marketing-details";

/** RVW-89: tells the business, before a message fails, that a marketing SMS needs its address and phone. */
export function MarketingSmsDetailsNotice({ orgId, missing }: { orgId: string; missing: MarketingDetailMissing[] }) {
  const text = marketingSmsMissingText(missing);
  if (!text) return null;
  return (
    <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
      {text} <TextLink href={documentSettingsPath(orgId)}>למילוי הפרטים</TextLink>
    </p>
  );
}
