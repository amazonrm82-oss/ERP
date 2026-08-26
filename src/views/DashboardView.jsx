import React, { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Receipt, Package, LifeBuoy, TrendingUp } from "lucide-react";
import { useRealtimeList } from "../lib/useTable";
import { colors, panelStyle } from "../lib/theme";
import { money } from "../lib/format";

function Tile({ icon: Icon, label, value }) {
  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: colors.muted, fontSize: 12, marginBottom: 6 }}>
        <Icon size={15} /> {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

export default function DashboardView({ profile }) {
  const { rows: invoices } = useRealtimeList("customer_invoices", { orderBy: "issued_at", ascending: false });
  const { rows: items } = useRealtimeList("inventory_items", { orderBy: "name", ascending: true });
  const { rows: movements } = useRealtimeList("inventory_movements", { orderBy: "created_at", ascending: false });
  const { rows: tickets } = useRealtimeList("support_tickets", { orderBy: "created_at", ascending: false });

  const openAR = invoices.reduce((s, i) => s + (i.amount - (i.paid_amount || 0)), 0);
  const openTickets = tickets.filter((t) => t.status !== "סגור").length;

  const lowStockCount = useMemo(() => {
    const stockByItem = new Map();
    for (const m of movements) stockByItem.set(m.item_id, (stockByItem.get(m.item_id) || 0) + Number(m.delta || 0));
    return items.filter((it) => (stockByItem.get(it.id) || 0) <= it.reorder_threshold).length;
  }, [items, movements]);

  const monthlyRevenue = useMemo(() => {
    const map = new Map();
    for (const inv of invoices) {
      const d = new Date(inv.issued_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      map.set(key, (map.get(key) || 0) + Number(inv.amount || 0));
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-6).map(([month, revenue]) => ({ month, revenue }));
  }, [invoices]);

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>שלום {profile.name}</div>
      <div style={{ fontSize: 13, color: colors.mutedText, marginBottom: 18 }}>תמונת מצב כללית</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
        <Tile icon={Receipt} label="חוב לקוחות פתוח" value={money(openAR)} />
        <Tile icon={Package} label="פריטים מתחת לסף מלאי" value={lowStockCount} />
        <Tile icon={LifeBuoy} label="פניות שירות פתוחות" value={openTickets} />
        <Tile icon={TrendingUp} label="הכנסה החודש" value={money(monthlyRevenue.at(-1)?.revenue || 0)} />
      </div>

      {monthlyRevenue.length > 0 && (
        <div style={panelStyle}>
          <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13.5 }}>הכנסה חודשית (6 חודשים אחרונים)</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={monthlyRevenue}>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.border} />
              <XAxis dataKey="month" fontSize={12} />
              <YAxis fontSize={12} />
              <Tooltip formatter={(v) => money(v)} />
              <Bar dataKey="revenue" fill={colors.accent} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
