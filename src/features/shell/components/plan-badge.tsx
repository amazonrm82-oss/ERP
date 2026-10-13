import { Badge } from "@/components/ui/badge";

import type { OrgContext } from "../queries";

type Props = {
  subscription: NonNullable<OrgContext["subscription"]>;
  trialDaysLeft: number;
  // BIL-08: true only while the business is in the trial-end transition (platform switch on)
  trialEndNotice?: boolean;
};

/** Plan / trial state next to the organization name. */
export function PlanBadge({ subscription, trialDaysLeft, trialEndNotice = false }: Props) {
  switch (subscription.status) {
    case "trialing": {
      if (trialDaysLeft <= 0) {
        // the switch is off (or the business is not covered): an ended trial keeps working on its plan, with no notice
        return trialEndNotice ? <Badge tone="warning">תקופת הניסיון הסתיימה</Badge> : <Badge tone="neutral">חבילת {subscription.planName}</Badge>;
      }
      const days = trialDaysLeft === 1 ? "יום אחד" : `${trialDaysLeft} ימים`;
      return (
        <Badge tone={trialDaysLeft <= 3 ? "warning" : "accent"}>
          <span className="hidden sm:inline">ניסיון בחבילת {subscription.planName}, נותרו&nbsp;</span>
          <span className="sm:hidden">ניסיון:&nbsp;</span>
          {days}
        </Badge>
      );
    }
    case "past_due":
      return <Badge tone="danger">תשלום נכשל</Badge>;
    case "cancelled":
      return <Badge tone="neutral">המנוי בוטל</Badge>;
    default:
      return <Badge tone="neutral">חבילת {subscription.planName}</Badge>;
  }
}
