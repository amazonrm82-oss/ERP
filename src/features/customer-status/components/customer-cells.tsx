import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";

import type { CustomerNumbers } from "../queries";
import { CUSTOMER_STATUS_LABELS, CUSTOMER_STATUS_TONES } from "../status";

/** CON-11: a list row's customer status or value; empty for a record that is not a customer (or a partial view). */
export function CustomerCell({ column, value }: { column: "customer_status" | "customer_value"; value: CustomerNumbers | undefined }) {
  if (!value) return null;
  if (column === "customer_status") {
    return value.status ? <Badge tone={CUSTOMER_STATUS_TONES[value.status]}>{CUSTOMER_STATUS_LABELS[value.status]}</Badge> : null;
  }
  return value.value === null ? null : <span className="tabular-nums">{formatMoney(value.value)}</span>;
}
