import { useCallback } from "react";
import { supabase } from "./supabaseClient";

export function useManufacturingActions(showToast, profile) {
  const addBomComponent = useCallback(async (parentItemId, componentItemId, qtyPerUnit) => {
    if (!parentItemId || !componentItemId || !qtyPerUnit) { showToast("יש לבחור מוצר, רכיב וכמות"); return; }
    if (parentItemId === componentItemId) { showToast("מוצר לא יכול להיות רכיב של עצמו"); return; }
    const { error } = await supabase.from("bom_components").insert({
      parent_item_id: parentItemId, component_item_id: componentItemId, qty_per_unit: Number(qtyPerUnit),
    });
    if (error) { showToast("אין הרשאה, או שגיאה בהוספת רכיב"); return; }
    showToast("הרכיב נוסף למק\"ט");
  }, [showToast]);

  const removeBomComponent = useCallback(async (id) => {
    await supabase.from("bom_components").delete().eq("id", id);
  }, []);

  const createWorkOrder = useCallback(async (itemId, qty) => {
    if (!itemId || !qty) { showToast("יש לבחור מוצר וכמות"); return null; }
    const { data, error } = await supabase.from("work_orders").insert({ item_id: itemId, qty: Number(qty), created_by: profile.id }).select().single();
    if (error) { showToast("אין הרשאה לפתוח פקודת עבודה, או שגיאה"); return null; }
    showToast("פקודת העבודה נפתחה");
    return data;
  }, [profile, showToast]);

  const setWorkOrderStatus = useCallback(async (wo, status) => {
    const { error } = await supabase.from("work_orders").update({ status }).eq("id", wo.id);
    if (error) { showToast(error.message.includes("הושלמה") ? error.message : "שגיאה בעדכון סטטוס"); return; }
    showToast(status === "הושלמה" ? "הפקודה הושלמה — המלאי עודכן" : "הסטטוס עודכן ל: " + status);
  }, [showToast]);

  return { addBomComponent, removeBomComponent, createWorkOrder, setWorkOrderStatus };
}
