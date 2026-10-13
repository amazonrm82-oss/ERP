"use client";

import { ActionButton } from "@/components/action-button";

import { deleteProductAction, duplicateProductAction, setProductArchivedAction } from "../actions";

/** Copy, archive or restore, and remove a product (PRD-02). Owners and admins only; the page decides. */
export function ProductActions({ orgId, productId, name, archived }: { orgId: string; productId: string; name: string; archived: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      <ActionButton action={duplicateProductAction.bind(null, orgId, productId)} pendingText="יוצרים עותק…" srLabel={name}>
        שכפול
      </ActionButton>
      <ActionButton action={setProductArchivedAction.bind(null, orgId, productId, !archived)} pendingText="מעדכנים…" srLabel={name}>
        {archived ? "החזרה מהארכיון" : "העברה לארכיון"}
      </ActionButton>
      <ActionButton
        action={deleteProductAction.bind(null, orgId, productId)}
        pendingText="מוחקים…"
        variant="danger-ghost"
        srLabel={name}
        confirm={`למחוק את "${name}" לצמיתות? מוצר שמופיע במסמכים אי אפשר למחוק, רק להעביר לארכיון.`}
        confirmLabel="מחיקה לצמיתות"
      >
        מחיקה
      </ActionButton>
    </div>
  );
}
