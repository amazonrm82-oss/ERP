import { useCallback } from "react";
import { supabase } from "./supabaseClient";

export function useProcurementActions(showToast, profile) {
  const addItem = useCallback(async (name, unit, reorderThreshold) => {
    if (!name.trim()) return;
    const { error } = await supabase.from("inventory_items").insert({
      name: name.trim(), unit: unit || "יח׳", reorder_threshold: Number(reorderThreshold) || 0,
    });
    if (error) { showToast("אין הרשאה להוסיף פריט, או שגיאה"); return; }
    showToast("הפריט נוסף למלאי");
  }, [showToast]);

  const adjustStock = useCallback(async (itemId, delta, reason) => {
    const { error } = await supabase.from("inventory_movements").insert({
      item_id: itemId, delta: Number(delta) || 0, reason: reason || "התאמת מלאי ידנית", created_by: profile.id,
    });
    if (error) { showToast("אין הרשאה לעדכן מלאי, או שגיאה"); return; }
    showToast("המלאי עודכן");
  }, [profile, showToast]);

  const addRequisition = useCallback(async (itemDescription, qty, notes) => {
    if (!itemDescription.trim() || !qty) { showToast("יש למלא תיאור וכמות"); return; }
    const { error } = await supabase.from("purchase_requisitions").insert({
      requested_by: profile.id, item_description: itemDescription, qty: Number(qty), notes: notes || null,
    });
    if (error) { showToast("שגיאה בפתיחת דרישת רכש"); return; }
    showToast("דרישת הרכש נשלחה לאישור");
  }, [profile, showToast]);

  const createPurchaseOrder = useCallback(async (supplierId, requisitionId, lines) => {
    if (!supplierId || !lines.length) { showToast("יש לבחור ספק ולהוסיף לפחות שורה אחת"); return null; }
    const { data: po, error } = await supabase.from("purchase_orders").insert({
      supplier_id: supplierId, requisition_id: requisitionId || null, created_by: profile.id,
    }).select().single();
    if (error) { showToast("אין הרשאה לפתוח הזמנת רכש, או שגיאה"); return null; }
    const { error: linesErr } = await supabase.from("purchase_order_lines").insert(
      lines.map((l) => ({ po_id: po.id, item_id: l.itemId || null, description: l.description, qty: Number(l.qty) || 0, unit_cost: Number(l.unitCost) || 0 }))
    );
    if (linesErr) { showToast("הזמנת הרכש נוצרה אך שורותיה נכשלו לשמור"); return po; }
    showToast("הזמנת הרכש נוצרה");
    return po;
  }, [profile, showToast]);

  const advancePoStatus = useCallback(async (po, nextStatus) => {
    const { error } = await supabase.from("purchase_orders").update({ status: nextStatus, approved_by: profile.id }).eq("id", po.id);
    if (error) { showToast(error.message.includes("מנהל") || error.message.includes("התקבלה") ? error.message : "שגיאה בעדכון סטטוס"); return; }
    showToast(nextStatus === "התקבל" ? "ההזמנה התקבלה — המלאי עודכן וחשבונית ספק נוצרה אוטומטית" : "הסטטוס עודכן ל: " + nextStatus);
  }, [profile, showToast]);

  return { addItem, adjustStock, addRequisition, createPurchaseOrder, advancePoStatus };
}
