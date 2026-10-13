"use client";

import { ActionButton } from "@/components/action-button";

import { deletePriceListAction } from "../actions";

/** Remove a price list for good (PL-01). Owners and admins only; the page decides. */
export function DeletePriceList({ orgId, listId, name }: { orgId: string; listId: string; name: string }) {
  return (
    <ActionButton
      action={deletePriceListAction.bind(null, orgId, listId)}
      pendingText="מוחקים…"
      variant="danger-ghost"
      srLabel={name}
      confirm={`למחוק את המחירון "${name}" לצמיתות, עם כל המחירים שבו? המוצרים והמחירים שלהם לא ישתנו.`}
      confirmLabel="מחיקה לצמיתות"
    >
      מחיקת המחירון
    </ActionButton>
  );
}
