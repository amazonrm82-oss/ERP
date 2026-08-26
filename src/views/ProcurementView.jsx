import React, { useState } from "react";
import { ClipboardList, Plus, Trash2 } from "lucide-react";
import { useRealtimeList } from "../lib/useTable";
import { useProcurementActions } from "../lib/procurementActions";
import { colors, panelStyle, inputStyle, buttonPrimary, buttonGhost } from "../lib/theme";
import { money, fmtDate } from "../lib/format";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";

const PO_STATUS_FLOW = ["ממתין לאישור", "אושר", "הוזמן", "התקבל"];
const BLANK_LINE = () => ({ description: "", qty: "", unitCost: "" });

export default function ProcurementView({ profile, showToast }) {
  const { rows: requisitions } = useRealtimeList("purchase_requisitions", { orderBy: "created_at", ascending: false });
  const { rows: suppliers } = useRealtimeList("suppliers", { orderBy: "name", ascending: true });
  const { rows: orders } = useRealtimeList("purchase_orders", { orderBy: "created_at", ascending: false });
  const { rows: orderLines } = useRealtimeList("purchase_order_lines", { orderBy: "id", ascending: true });
  const actions = useProcurementActions(showToast, profile);

  const [reqForm, setReqForm] = useState({ description: "", qty: "", notes: "" });
  const [poSupplier, setPoSupplier] = useState("");
  const [poLines, setPoLines] = useState([BLANK_LINE()]);

  async function submitRequisition(e) {
    e.preventDefault();
    await actions.addRequisition(reqForm.description, reqForm.qty, reqForm.notes);
    setReqForm({ description: "", qty: "", notes: "" });
  }

  async function submitPo(e) {
    e.preventDefault();
    const validLines = poLines.filter((l) => l.description && l.qty);
    const po = await actions.createPurchaseOrder(poSupplier, null, validLines);
    if (po) { setPoSupplier(""); setPoLines([BLANK_LINE()]); }
  }

  function supplierName(id) { return suppliers.find((s) => s.id === id)?.name || "—"; }
  function linesFor(poId) { return orderLines.filter((l) => l.po_id === poId); }
  function poTotal(poId) { return linesFor(poId).reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost), 0); }

  return (
    <div>
      <PageHeader icon={ClipboardList} title="רכש" subtitle={`${orders.length} הזמנות רכש`} />

      <div style={{ ...panelStyle, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13.5 }}>דרישת רכש חדשה</div>
        <form onSubmit={submitRequisition} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input style={{ ...inputStyle, flex: 1, minWidth: 160 }} placeholder="מה צריך?" value={reqForm.description} onChange={(e) => setReqForm({ ...reqForm, description: e.target.value })} />
          <input type="number" style={{ ...inputStyle, width: 100 }} placeholder="כמות" value={reqForm.qty} onChange={(e) => setReqForm({ ...reqForm, qty: e.target.value })} />
          <input style={{ ...inputStyle, width: 180 }} placeholder="הערות" value={reqForm.notes} onChange={(e) => setReqForm({ ...reqForm, notes: e.target.value })} />
          <button type="submit" style={buttonPrimary}>שליחה לאישור</button>
        </form>
        {requisitions.filter((r) => r.status === "ממתין לאישור").length > 0 && (
          <div style={{ marginTop: 10, display: "grid", gap: 4 }}>
            {requisitions.filter((r) => r.status === "ממתין לאישור").map((r) => (
              <div key={r.id} style={{ fontSize: 12.5, color: colors.mutedText }}>• {r.item_description} ({r.qty}) — ממתין לאישור</div>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={submitPo} style={{ ...panelStyle, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13.5 }}>הזמנת רכש חדשה</div>
        <select style={{ ...inputStyle, marginBottom: 8 }} value={poSupplier} onChange={(e) => setPoSupplier(e.target.value)}>
          <option value="">בחר ספק…</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {poLines.map((line, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input style={{ ...inputStyle, flex: 1 }} placeholder="תיאור" value={line.description} onChange={(e) => setPoLines((ls) => ls.map((l, idx) => idx === i ? { ...l, description: e.target.value } : l))} />
            <input type="number" style={{ ...inputStyle, width: 90 }} placeholder="כמות" value={line.qty} onChange={(e) => setPoLines((ls) => ls.map((l, idx) => idx === i ? { ...l, qty: e.target.value } : l))} />
            <input type="number" style={{ ...inputStyle, width: 110 }} placeholder="עלות ליחידה" value={line.unitCost} onChange={(e) => setPoLines((ls) => ls.map((l, idx) => idx === i ? { ...l, unitCost: e.target.value } : l))} />
            {poLines.length > 1 && (
              <button type="button" onClick={() => setPoLines((ls) => ls.filter((_, idx) => idx !== i))} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer" }}>
                <Trash2 size={16} />
              </button>
            )}
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button type="button" onClick={() => setPoLines((ls) => [...ls, BLANK_LINE()])} style={{ ...buttonGhost, display: "flex", alignItems: "center", gap: 4, fontSize: 12.5 }}>
            <Plus size={14} /> שורה נוספת
          </button>
          <button type="submit" style={buttonPrimary}>פתיחת הזמנת רכש</button>
        </div>
      </form>

      {orders.length === 0 ? <EmptyState icon={ClipboardList} text="אין עדיין הזמנות רכש" /> : (
        <div style={{ display: "grid", gap: 8 }}>
          {orders.map((po) => {
            const nextIdx = PO_STATUS_FLOW.indexOf(po.status) + 1;
            const nextStatus = po.status === "נדחה" ? null : PO_STATUS_FLOW[nextIdx];
            return (
              <div key={po.id} style={panelStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{supplierName(po.supplier_id)}</div>
                    <div style={{ fontSize: 12, color: colors.mutedText }}>{fmtDate(po.created_at)} · {linesFor(po.id).length} שורות</div>
                  </div>
                  <div style={{ textAlign: "left" }}>
                    <div style={{ fontWeight: 800 }}>{money(poTotal(po.id))}</div>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: po.status === "התקבל" ? colors.accent : colors.muted }}>{po.status}</div>
                  </div>
                </div>
                {nextStatus && (
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button style={buttonPrimary} onClick={() => actions.advancePoStatus(po, nextStatus)}>קידום ל: {nextStatus}</button>
                    {po.status === "ממתין לאישור" && <button style={buttonGhost} onClick={() => actions.advancePoStatus(po, "נדחה")}>דחייה</button>}
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
