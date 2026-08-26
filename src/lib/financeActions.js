import { useCallback } from "react";
import { supabase } from "./supabaseClient";

// Finance-module mutations — one async function per action, direct supabase call. Journal
// entries are posted as one transaction + its lines in a single call so the balance-check
// trigger (deferred to end-of-statement) always sees the complete set of lines.
export function useFinanceActions(showToast, profile) {
  const issueInvoice = useCallback(async (customerId, docType, amount, note) => {
    const { data, error } = await supabase.from("customer_invoices").insert({
      customer_id: customerId || null, doc_type: docType, amount: Number(amount) || 0, note: note || null, issued_by: profile.id,
    }).select().single();
    if (error) { showToast("אין הרשאה להפיק מסמך, או שגיאה בהפקה"); return null; }
    showToast(`${docType} מס' ${data.doc_number} הופקה`);
    return data;
  }, [profile, showToast]);

  const recordInvoicePayment = useCallback(async (invoice, amount) => {
    const newPaid = (invoice.paid_amount || 0) + (Number(amount) || 0);
    const { error } = await supabase.from("customer_invoices").update({ paid_amount: newPaid }).eq("id", invoice.id);
    if (error) { showToast("שגיאה ברישום תשלום"); return; }
    showToast("התשלום נרשם");
  }, [showToast]);

  // lines: [{accountId, debit, credit}] — must already sum debit === sum credit; the DB enforces
  // this too (belt-and-suspenders), but a bad call still fails clearly rather than silently.
  const postJournalEntry = useCallback(async (date, description, lines) => {
    const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) { showToast("התנועה לא מאוזנת — חובה חייב להיות שווה לזכות"); return null; }
    const { data: txn, error: txnErr } = await supabase.from("gl_transactions").insert({
      txn_date: date, description, created_by: profile.id,
    }).select().single();
    if (txnErr) { showToast("אין הרשאה לרשום תנועת יומן, או שגיאה"); return null; }
    const { error: linesErr } = await supabase.from("gl_lines").insert(
      lines.map((l) => ({ transaction_id: txn.id, account_id: l.accountId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 }))
    );
    if (linesErr) { showToast("שגיאה ברישום שורות התנועה: " + linesErr.message); return null; }
    showToast("התנועה נרשמה");
    return txn;
  }, [profile, showToast]);

  const addSupplier = useCallback(async (name) => {
    if (!name.trim()) return;
    const { error } = await supabase.from("suppliers").insert({ name: name.trim() });
    if (error) { showToast("שגיאה בהוספת ספק"); return; }
    showToast("הספק נוסף");
  }, [showToast]);

  const addSupplierBill = useCallback(async (supplierId, billNumber, amount, dueDate) => {
    if (!supplierId || !amount) { showToast("יש לבחור ספק ולהזין סכום"); return; }
    const { error } = await supabase.from("supplier_bills").insert({
      supplier_id: supplierId, bill_number: billNumber || null, amount: Number(amount) || 0, due_date: dueDate || null, created_by: profile.id,
    });
    if (error) { showToast("אין הרשאה להוסיף חשבונית ספק, או שגיאה"); return; }
    showToast("חשבונית הספק נוספה");
  }, [profile, showToast]);

  const toggleBillPaid = useCallback(async (bill) => {
    const { error } = await supabase.from("supplier_bills").update({ paid: !bill.paid }).eq("id", bill.id);
    if (error) showToast("אין הרשאה לעדכן");
  }, [showToast]);

  return { issueInvoice, recordInvoicePayment, postJournalEntry, addSupplier, addSupplierBill, toggleBillPaid };
}
