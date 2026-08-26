import { useCallback } from "react";
import { supabase } from "./supabaseClient";

export function useSalesActions(showToast, profile) {
  const addLead = useCallback(async (contactName, phone, source) => {
    if (!contactName.trim()) return;
    const { error } = await supabase.from("sales_leads").insert({ contact_name: contactName.trim(), phone: phone || null, source: source || null, created_by: profile.id });
    if (error) { showToast("שגיאה בהוספת ליד"); return; }
    showToast("הליד נוסף");
  }, [profile, showToast]);

  const updateLeadStatus = useCallback(async (lead, status) => {
    await supabase.from("sales_leads").update({ status }).eq("id", lead.id);
  }, []);

  const createQuote = useCallback(async (leadId, customerId, lines) => {
    const validLines = lines.filter((l) => l.description && l.qty);
    if (!validLines.length) { showToast("יש להוסיף לפחות שורה אחת"); return null; }
    const { data: quote, error } = await supabase.from("quotes").insert({ lead_id: leadId || null, customer_id: customerId || null, created_by: profile.id }).select().single();
    if (error) { showToast("שגיאה ביצירת הצעת מחיר"); return null; }
    const { error: linesErr } = await supabase.from("quote_lines").insert(
      validLines.map((l) => ({ quote_id: quote.id, description: l.description, qty: Number(l.qty), unit_price: Number(l.unitPrice) || 0 }))
    );
    if (linesErr) { showToast("הצעת המחיר נוצרה אך שורותיה נכשלו לשמור"); return quote; }
    showToast("הצעת המחיר נוצרה");
    return quote;
  }, [profile, showToast]);

  // Copies a quote's lines into a brand-new sales order — the quote itself is left untouched as
  // a historical record, matching the immutable-document principle used for invoices elsewhere.
  const convertQuoteToOrder = useCallback(async (quote, quoteLines, customerId) => {
    if (!customerId) { showToast("להצעה הזו אין לקוח משויך — יש לשייך לקוח לפני המרה"); return null; }
    const { data: order, error } = await supabase.from("sales_orders").insert({ customer_id: customerId, quote_id: quote.id, created_by: profile.id }).select().single();
    if (error) { showToast("שגיאה ביצירת הזמנת מכירה"); return null; }
    const { error: linesErr } = await supabase.from("sales_order_lines").insert(
      quoteLines.map((l) => ({ order_id: order.id, description: l.description, qty: l.qty, unit_price: l.unit_price }))
    );
    if (linesErr) { showToast("ההזמנה נוצרה אך שורותיה נכשלו לשמור"); return order; }
    showToast("הצעת המחיר הומרה להזמנת מכירה");
    return order;
  }, [profile, showToast]);

  const advanceOrderStatus = useCallback(async (order, status) => {
    const { error } = await supabase.from("sales_orders").update({ status }).eq("id", order.id);
    if (error) { showToast(error.message.includes("נסגרה") ? error.message : "אין הרשאה, או שגיאה בעדכון"); return; }
    showToast(status === "נסגרה" ? "ההזמנה נסגרה — חשבונית הופקה אוטומטית" : "הסטטוס עודכן ל: " + status);
  }, [showToast]);

  return { addLead, updateLeadStatus, createQuote, convertQuoteToOrder, advanceOrderStatus };
}
