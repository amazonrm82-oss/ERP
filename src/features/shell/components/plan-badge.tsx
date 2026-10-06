import { Badge } from "@/components/ui/badge";

import type { OrgContext } from "../queries";

type Props = { subscription: NonNullable<OrgContext["subscription"]>; trialDaysLeft: number };

/** Plan / trial state next to the organization name. */
export function PlanBadge({ subscription, trialDaysLeft }: Props) {
  switch (subscription.status) {
    case "trialing": {
      if (trialDaysLeft <= 0) {
        return <Badge tone="warning">תקופת הניסיון הסתיימה</Badge>;
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
