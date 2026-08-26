import React from "react";
import { LayoutDashboard, Users, Receipt, BookOpen, Truck, LogOut, Package, ClipboardList, Factory, TrendingUp, LifeBuoy, Contact, FolderKanban, Settings } from "lucide-react";
import { colors } from "../lib/theme";
import { supabase } from "../lib/supabaseClient";

// Extended as each module is built. { key, label, icon, group }.
export const NAV_ITEMS = [
  { key: "home", label: "בית", icon: LayoutDashboard, group: "כללי" },
  { key: "customers", label: "לקוחות", icon: Users, group: "כללי" },
  { key: "invoices", label: "חשבוניות וגבייה", icon: Receipt, group: "כספים" },
  { key: "ledger", label: "הנהלת חשבונות", icon: BookOpen, group: "כספים" },
  { key: "payables", label: "ספקים ותשלומים", icon: Truck, group: "כספים" },
  { key: "inventory", label: "מלאי", icon: Package, group: "רכש ומלאי" },
  { key: "procurement", label: "רכש", icon: ClipboardList, group: "רכש ומלאי" },
  { key: "manufacturing", label: "ייצור", icon: Factory, group: "רכש ומלאי" },
  { key: "sales", label: "מכירות ו-CRM", icon: TrendingUp, group: "מכירות" },
  { key: "support", label: "שירות לקוחות", icon: LifeBuoy, group: "מכירות" },
  { key: "hr", label: "משאבי אנוש", icon: Contact, group: "אנשים" },
  { key: "projects", label: "ניהול פרויקטים", icon: FolderKanban, group: "אנשים" },
  { key: "settings", label: "הגדרות", icon: Settings, group: "מערכת" },
];

export default function Sidebar({ profile, view, setView }) {
  const groups = [...new Set(NAV_ITEMS.map((i) => i.group))];
  return (
    <div style={{
      width: 220, flexShrink: 0, background: "#fff", borderInlineEnd: `1px solid ${colors.border}`,
      display: "flex", flexDirection: "column", height: "100vh", position: "sticky", top: 0,
    }}>
      <div style={{ padding: "18px 16px", background: colors.header, color: "#fff", fontWeight: 800, fontSize: 16 }}>
        ERP
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
        {groups.map((g) => (
          <div key={g} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: colors.muted, fontWeight: 700, margin: "6px 8px" }}>{g}</div>
            {NAV_ITEMS.filter((i) => i.group === g).map((item) => {
              const Icon = item.icon;
              const active = view === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => setView(item.key)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 10px",
                    borderRadius: 8, border: "none", cursor: "pointer", marginBottom: 2,
                    background: active ? `${colors.accent}18` : "transparent",
                    color: active ? colors.text : "#4a5361", fontWeight: active ? 700 : 500, fontSize: 13.5, textAlign: "right",
                  }}
                >
                  <Icon size={17} color={active ? colors.accent : colors.muted} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div style={{ padding: 10, borderTop: `1px solid ${colors.border}` }}>
        <div style={{ fontSize: 12.5, color: colors.muted, padding: "0 8px 8px" }}>{profile.name} · {profile.role}</div>
        <button onClick={() => supabase.auth.signOut()} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 10px", borderRadius: 8, border: "none", cursor: "pointer", background: "transparent", color: colors.danger, fontSize: 13.5 }}>
          <LogOut size={17} /> יציאה
        </button>
      </div>
    </div>
  );
}
