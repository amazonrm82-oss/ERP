import React, { useState } from "react";
import { Factory } from "lucide-react";
import { useRealtimeList } from "../lib/useTable";
import { useManufacturingActions } from "../lib/manufacturingActions";
import { colors, panelStyle, inputStyle, buttonPrimary, buttonGhost } from "../lib/theme";
import { fmtDate } from "../lib/format";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";

const WO_NEXT = { "פתוחה": "בייצור", "בייצור": "הושלמה" };

export default function ManufacturingView({ profile, showToast }) {
  const { rows: items } = useRealtimeList("inventory_items", { orderBy: "name", ascending: true });
  const { rows: bom } = useRealtimeList("bom_components", { orderBy: "id", ascending: true });
  const { rows: workOrders } = useRealtimeList("work_orders", { orderBy: "created_at", ascending: false });
  const actions = useManufacturingActions(showToast, profile);

  const [bomForm, setBomForm] = useState({ parentId: "", componentId: "", qtyPerUnit: "" });
  const [woForm, setWoForm] = useState({ itemId: "", qty: "" });

  function itemName(id) { return items.find((i) => i.id === id)?.name || "—"; }

  async function submitBom(e) {
    e.preventDefault();
    await actions.addBomComponent(bomForm.parentId, bomForm.componentId, bomForm.qtyPerUnit);
    setBomForm({ ...bomForm, componentId: "", qtyPerUnit: "" });
  }

  async function submitWo(e) {
    e.preventDefault();
    const wo = await actions.createWorkOrder(woForm.itemId, woForm.qty);
    if (wo) setWoForm({ itemId: "", qty: "" });
  }

  return (
    <div>
      <PageHeader icon={Factory} title="ייצור" subtitle={`${workOrders.length} פקודות עבודה`} />

      <div style={{ ...panelStyle, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13.5 }}>מק"ט (BOM) — מה מרכיב כל מוצר</div>
        <form onSubmit={submitBom} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <select style={{ ...inputStyle, width: 160 }} value={bomForm.parentId} onChange={(e) => setBomForm({ ...bomForm, parentId: e.target.value })}>
            <option value="">מוצר מוגמר…</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <select style={{ ...inputStyle, width: 160 }} value={bomForm.componentId} onChange={(e) => setBomForm({ ...bomForm, componentId: e.target.value })}>
            <option value="">רכיב…</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <input type="number" style={{ ...inputStyle, width: 120 }} placeholder="כמות ליחידה" value={bomForm.qtyPerUnit} onChange={(e) => setBomForm({ ...bomForm, qtyPerUnit: e.target.value })} />
          <button type="submit" style={buttonGhost}>הוספה</button>
        </form>
        {bomForm.parentId && (
          <div style={{ display: "grid", gap: 4 }}>
            {bom.filter((b) => b.parent_item_id === bomForm.parentId).map((b) => (
              <div key={b.id} style={{ fontSize: 12.5, display: "flex", justifyContent: "space-between" }}>
                <span>{itemName(b.component_item_id)} × {b.qty_per_unit}</span>
                <button onClick={() => actions.removeBomComponent(b.id)} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer" }}>הסר</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={submitWo} style={{ ...panelStyle, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select style={{ ...inputStyle, width: 200 }} value={woForm.itemId} onChange={(e) => setWoForm({ ...woForm, itemId: e.target.value })}>
          <option value="">מה מייצרים?</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <input type="number" style={{ ...inputStyle, width: 120 }} placeholder="כמות" value={woForm.qty} onChange={(e) => setWoForm({ ...woForm, qty: e.target.value })} />
        <button type="submit" style={buttonPrimary}>פתיחת פקודת עבודה</button>
      </form>

      {workOrders.length === 0 ? <EmptyState icon={Factory} text="אין עדיין פקודות עבודה" /> : (
        <div style={{ display: "grid", gap: 8 }}>
          {workOrders.map((wo) => (
            <div key={wo.id} style={{ ...panelStyle, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{itemName(wo.item_id)} × {wo.qty}</div>
                <div style={{ fontSize: 12, color: colors.mutedText }}>{fmtDate(wo.created_at)} · {wo.status}</div>
              </div>
              {WO_NEXT[wo.status] && (
                <button style={buttonPrimary} onClick={() => actions.setWorkOrderStatus(wo, WO_NEXT[wo.status])}>
                  קידום ל: {WO_NEXT[wo.status]}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
