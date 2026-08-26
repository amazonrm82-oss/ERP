import React, { useMemo, useState } from "react";
import { Package } from "lucide-react";
import { useRealtimeList } from "../lib/useTable";
import { useProcurementActions } from "../lib/procurementActions";
import { colors, panelStyle, inputStyle, buttonPrimary, buttonGhost } from "../lib/theme";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";

export default function InventoryView({ profile, showToast }) {
  const { rows: items } = useRealtimeList("inventory_items", { orderBy: "name", ascending: true });
  const { rows: movements } = useRealtimeList("inventory_movements", { orderBy: "created_at", ascending: false });
  const actions = useProcurementActions(showToast, profile);
  const [form, setForm] = useState({ name: "", unit: "יח׳", reorderThreshold: "" });
  const [adjust, setAdjust] = useState({});

  const stockByItem = useMemo(() => {
    const map = new Map();
    for (const m of movements) map.set(m.item_id, (map.get(m.item_id) || 0) + Number(m.delta || 0));
    return map;
  }, [movements]);

  async function submit(e) {
    e.preventDefault();
    await actions.addItem(form.name, form.unit, form.reorderThreshold);
    setForm({ name: "", unit: "יח׳", reorderThreshold: "" });
  }

  return (
    <div>
      <PageHeader icon={Package} title="מלאי" subtitle={`${items.length} פריטים`} />
      <form onSubmit={submit} style={{ ...panelStyle, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input style={{ ...inputStyle, width: 200 }} placeholder="שם הפריט" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input style={{ ...inputStyle, width: 100 }} placeholder="יחידה" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
        <input type="number" style={{ ...inputStyle, width: 140 }} placeholder="סף הזמנה חוזרת" value={form.reorderThreshold} onChange={(e) => setForm({ ...form, reorderThreshold: e.target.value })} />
        <button type="submit" style={buttonPrimary}>הוספת פריט</button>
      </form>
      {items.length === 0 ? <EmptyState icon={Package} text="אין עדיין פריטים במלאי" /> : (
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((it) => {
            const stock = stockByItem.get(it.id) || 0;
            const low = stock <= it.reorder_threshold;
            return (
              <div key={it.id} style={{ ...panelStyle, border: low ? `1.5px solid ${colors.danger}` : "none", background: low ? "#fdecea" : panelStyle.background }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{it.name}</div>
                    <div style={{ fontSize: 12, color: colors.mutedText }}>{it.location || "—"} · סף הזמנה חוזרת: {it.reorder_threshold} {it.unit}</div>
                  </div>
                  <div style={{ textAlign: "left" }}>
                    <div style={{ fontWeight: 800, color: low ? colors.danger : colors.text }}>{stock} {it.unit}</div>
                    {low && <div style={{ fontSize: 11, color: colors.danger }}>מתחת לסף — מומלץ להזמין</div>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <input type="number" style={{ ...inputStyle, width: 100 }} placeholder="+/- כמות"
                    value={adjust[it.id] || ""} onChange={(e) => setAdjust({ ...adjust, [it.id]: e.target.value })} />
                  <button style={buttonGhost} onClick={() => { actions.adjustStock(it.id, adjust[it.id], "התאמת מלאי ידנית"); setAdjust({ ...adjust, [it.id]: "" }); }}>
                    התאמת מלאי
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
