import React, { useState } from "react";
import { Receipt } from "lucide-react";
import { useRealtimeList } from "../lib/useTable";
import { useFinanceActions } from "../lib/financeActions";
import { colors, panelStyle, inputStyle, buttonPrimary, buttonGhost } from "../lib/theme";
import { money, fmtDate } from "../lib/format";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";

const DOC_TYPES = ["חשבונית", "קבלה", "חשבונית מס-קבלה"];

export default function InvoicesView({ profile, showToast }) {
  const { rows: invoices } = useRealtimeList("customer_invoices", { orderBy: "issued_at", ascending: false });
  const { rows: customers } = useRealtimeList("customers", { orderBy: "name", ascending: true });
  const actions = useFinanceActions(showToast, profile);
  const [form, setForm] = useState({ customerId: "", docType: DOC_TYPES[0], amount: "", note: "" });
  const [payInputs, setPayInputs] = useState({});

  async function submit(e) {
    e.preventDefault();
    if (!form.amount) { showToast("יש להזין סכום"); return; }
    const doc = await actions.issueInvoice(form.customerId || null, form.docType, form.amount, form.note);
    if (doc) setForm({ customerId: "", docType: DOC_TYPES[0], amount: "", note: "" });
  }

  function customerLabel(id) {
    const c = customers.find((x) => x.id === id);
    return c ? c.name : "—";
  }

  return (
    <div>
      <PageHeader icon={Receipt} title="חשבוניות וגבייה" subtitle={`${invoices.length} מסמכים`} />
      <form onSubmit={submit} style={{ ...panelStyle, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select style={{ ...inputStyle, width: 160 }} value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
          <option value="">בחר לקוח…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={{ ...inputStyle, width: 150 }} value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })}>
          {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input type="number" style={{ ...inputStyle, width: 120 }} placeholder="סכום" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        <input style={{ ...inputStyle, width: 180 }} placeholder="הערה (אופציונלי)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        <button type="submit" style={buttonPrimary}>הפקת מסמך</button>
      </form>
      {invoices.length === 0 ? <EmptyState icon={Receipt} text="עדיין לא הופקו מסמכים" /> : (
        <div style={{ display: "grid", gap: 8 }}>
          {invoices.map((inv) => {
            const remaining = inv.amount - (inv.paid_amount || 0);
            return (
              <div key={inv.id} style={panelStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>#{inv.doc_number} · {inv.doc_type} · {customerLabel(inv.customer_id)}</div>
                    <div style={{ fontSize: 12, color: colors.mutedText }}>{fmtDate(inv.issued_at)} {inv.note ? `· ${inv.note}` : ""}</div>
                  </div>
                  <div style={{ textAlign: "left" }}>
                    <div style={{ fontWeight: 800 }}>{money(inv.amount)}</div>
                    {remaining > 0 && <div style={{ fontSize: 11.5, color: colors.danger }}>נותר {money(remaining)}</div>}
                  </div>
                </div>
                {remaining > 0 && (
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <input type="number" style={{ ...inputStyle, width: 110 }} placeholder="סכום תשלום"
                      value={payInputs[inv.id] || ""} onChange={(e) => setPayInputs({ ...payInputs, [inv.id]: e.target.value })} />
                    <button style={buttonGhost} onClick={() => { actions.recordInvoicePayment(inv, payInputs[inv.id]); setPayInputs({ ...payInputs, [inv.id]: "" }); }}>
                      רישום תשלום
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
