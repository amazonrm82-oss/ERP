import React, { useState } from "react";
import { Truck } from "lucide-react";
import { useRealtimeList } from "../lib/useTable";
import { useFinanceActions } from "../lib/financeActions";
import { colors, panelStyle, inputStyle, buttonPrimary, buttonGhost } from "../lib/theme";
import { money } from "../lib/format";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";

export default function PayablesView({ profile, showToast }) {
  const { rows: suppliers } = useRealtimeList("suppliers", { orderBy: "name", ascending: true });
  const { rows: bills } = useRealtimeList("supplier_bills", { orderBy: "created_at", ascending: false });
  const actions = useFinanceActions(showToast, profile);
  const [newSupplier, setNewSupplier] = useState("");
  const [form, setForm] = useState({ supplierId: "", billNumber: "", amount: "", dueDate: "" });

  async function submit(e) {
    e.preventDefault();
    await actions.addSupplierBill(form.supplierId, form.billNumber, form.amount, form.dueDate);
    setForm({ supplierId: "", billNumber: "", amount: "", dueDate: "" });
  }

  function supplierName(id) { return suppliers.find((s) => s.id === id)?.name || "—"; }
  const unpaid = bills.filter((b) => !b.paid);

  return (
    <div>
      <PageHeader icon={Truck} title="ספקים ותשלומים" subtitle={`${unpaid.length} חשבוניות פתוחות`} />

      <div style={{ ...panelStyle, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13.5 }}>רשימת ספקים</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {suppliers.map((s) => <span key={s.id} style={{ background: colors.bg, borderRadius: 20, padding: "4px 10px", fontSize: 12.5 }}>{s.name}</span>)}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input style={inputStyle} placeholder="שם ספק חדש" value={newSupplier} onChange={(e) => setNewSupplier(e.target.value)} />
          <button style={buttonGhost} onClick={() => { actions.addSupplier(newSupplier); setNewSupplier(""); }}>הוסף</button>
        </div>
      </div>

      <form onSubmit={submit} style={{ ...panelStyle, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select style={{ ...inputStyle, width: 150 }} value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
          <option value="">בחר ספק…</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input style={{ ...inputStyle, width: 130 }} placeholder="מס' חשבונית" value={form.billNumber} onChange={(e) => setForm({ ...form, billNumber: e.target.value })} />
        <input type="number" style={{ ...inputStyle, width: 110 }} placeholder="סכום" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        <input type="date" style={{ ...inputStyle, width: 150 }} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
        <button type="submit" style={buttonPrimary}>הוספת חשבונית</button>
      </form>

      {unpaid.length === 0 ? <EmptyState icon={Truck} text="אין חשבוניות ספקים פתוחות" /> : (
        <div style={{ display: "grid", gap: 8 }}>
          {unpaid.map((b) => (
            <div key={b.id} style={{ ...panelStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 700 }}>{supplierName(b.supplier_id)} · {money(b.amount)}</div>
                <div style={{ fontSize: 12, color: colors.mutedText }}>{b.bill_number || "—"} {b.due_date ? `· לתשלום עד ${b.due_date}` : ""}</div>
              </div>
              <button style={buttonPrimary} onClick={() => actions.toggleBillPaid(b)}>סמן כשולם</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
