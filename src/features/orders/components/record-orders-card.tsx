import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";

import { orderFromDealAction } from "../actions";

import { getOrdersAccess } from "../access";
import { listRecordOrders } from "../queries";
import { NewOrderButton } from "./new-order-button";
import { OrderListItems } from "./order-list-items";

type Props = {
  orgId: string;
  subject: { kind: "deal" | "contact" | "company"; id: string };
  // the person may edit the record (RLS decides again)
  canCreate: boolean;
  // a won deal also offers an order with its own lines (owner (4); the database refuses when it has an accepted quote)
  dealWon?: boolean;
};

/** ORD-01: the orders of a deal, a contact or a company, with "הזמנה חדשה". Only while the orders module is on. */
export async function RecordOrdersCard({ orgId, subject, canCreate, dealWon = false }: Props) {
  const access = await getOrdersAccess(orgId);
  if (!access.on) return null;
  const orders = await listRecordOrders(orgId, subject);
  if (orders.length === 0 && !canCreate) return null;
  const empty = subject.kind === "deal" ? "עוד אין הזמנות לעסקה." : subject.kind === "contact" ? "עוד אין הזמנות לאיש הקשר." : "עוד אין הזמנות לחברה.";
  return (
    <Card aria-labelledby={`orders-${subject.id}`} className="print:hidden">
      <CardHeader
        id={`orders-${subject.id}`}
        title="הזמנות"
        action={
          canCreate ? (
            <span className="flex flex-wrap items-start justify-end gap-2">
              {subject.kind === "deal" && dealWon ? (
                <ConfirmButton
                  variant="secondary"
                  title="ליצור הזמנה מהעסקה?"
                  description="תיווצר הזמנה ממוספרת עם השורות של העסקה כפי שהן: מחיר, מע״מ וחיוב. אם לעסקה יש הצעת מחיר שאושרה, יוצרים את ההזמנה מההצעה."
                  confirmLabel="יצירת הזמנה"
                  action={orderFromDealAction.bind(null, orgId, subject.id)}
                >
                  הזמנה מהעסקה
                </ConfirmButton>
              ) : null}
              <NewOrderButton orgId={orgId} source={subject} />
            </span>
          ) : null
        }
      />
      <CardBody className="p-0">
        {orders.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-soft">{empty}</p>
        ) : (
          <ul className="divide-y divide-line">
            <OrderListItems orgId={orgId} orders={orders} showCustomer={subject.kind !== "contact"} />
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
