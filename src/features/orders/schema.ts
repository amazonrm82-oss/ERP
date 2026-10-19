import { z } from "zod";

import { quantityField } from "@/features/deal-lines/schema";
import { moneyField, optionalDate, optionalId, optionalText, requiredText } from "@/lib/validation";

// ORD-01 / ORD-02 / ORD-03: an order and its lines. Mirrors the checks of public.orders and public.order_lines
// (migration orders).

export const ORDER_NOTES_MAX = 4000;
export const ORDER_SHIPPING_MAX = 500;
export const ORDER_LINE_NAME_MAX = 300;
export const ORDER_LINE_DESCRIPTION_MAX = 2000;
// app.order_lines_check
export const ORDER_LINES_MAX = 200;

export const ORDER_STATUSES = ["draft", "new", "in_progress", "partly_delivered", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "טיוטה",
  new: "חדשה",
  in_progress: "בטיפול",
  partly_delivered: "סופקה חלקית",
  delivered: "סופקה",
  cancelled: "בוטלה",
};

/** ORD-02: the states a person moves a numbered order between (a draft is numbered by "אישור", never chosen here). */
export const MOVABLE_STATUSES = ["new", "in_progress", "partly_delivered", "delivered"] as const;
export type MovableStatus = (typeof MOVABLE_STATUSES)[number];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export const ORDER_SOURCES = ["manual", "quote", "deal"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];
export const ORDER_SOURCE_LABELS: Record<OrderSource, string> = {
  manual: "ידנית",
  quote: "מהצעת מחיר",
  deal: "מעסקה",
};

export function isOrderSource(value: unknown): value is OrderSource {
  return typeof value === "string" && (ORDER_SOURCES as readonly string[]).includes(value);
}

/** What a person may still change, by state (owner, 19 October 2026). */
export function orderEditing(status: OrderStatus): { lines: boolean; details: boolean; status: boolean } {
  return {
    // lines and prices only on a draft; a numbered order keeps them (a price changes only through a quote addendum)
    lines: status === "draft",
    // delivery date, shipping address, notes and the delivery contact while the order is not cancelled
    details: status !== "cancelled",
    status: status !== "draft" && status !== "cancelled",
  };
}

/** The delivery details: editable on every order that is not cancelled. */
export const orderDetailsSchema = z.object({
  delivery_date: optionalDate,
  shipping_address: optionalText(ORDER_SHIPPING_MAX, `כתובת המשלוח ארוכה מדי (עד ${ORDER_SHIPPING_MAX} תווים).`),
  notes: optionalText(ORDER_NOTES_MAX, `ההערות ארוכות מדי (עד ${ORDER_NOTES_MAX} תווים).`),
  delivery_contact_id: optionalId,
});
export const ORDER_DETAILS_FIELD_NAMES = ["delivery_date", "shipping_address", "notes", "delivery_contact_id"] as const;

// empty = the automatic price on a product line (PL-03); a free line needs one (checked by the action)
const priceField = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string()).transform((value, ctx) => {
  if (value === "") return null;
  const parsed = moneyField.safeParse(value);
  if (!parsed.success || parsed.data > 1_000_000_000_000) {
    ctx.addIssue({ code: "custom", message: "יש להזין מחיר בשקלים, למשל 120 או 99.90." });
    return z.NEVER;
  }
  return parsed.data;
});

/** A line of a draft: a product (priced by PL-03 when the price is left empty) or a free line with its own price. */
export const orderLineSchema = z.object({
  product_id: optionalId,
  name: requiredText(ORDER_LINE_NAME_MAX, "יש לכתוב שם לשורה.", `השם ארוך מדי (עד ${ORDER_LINE_NAME_MAX} תווים).`),
  description: optionalText(ORDER_LINE_DESCRIPTION_MAX, `התיאור ארוך מדי (עד ${ORDER_LINE_DESCRIPTION_MAX} תווים).`),
  quantity: quantityField,
  unit_price: priceField,
});
export const ORDER_LINE_FIELD_NAMES = ["product_id", "name", "description", "quantity", "unit_price"] as const;
