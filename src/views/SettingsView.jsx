import React from "react";
import { Settings } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useRealtimeList } from "../lib/useTable";
import { colors, panelStyle, inputStyle } from "../lib/theme";
import PageHeader from "../components/PageHeader";

const PERMISSION_FLAGS = [
  ["can_manage_finance", "כספים"],
  ["can_manage_procurement", "רכש"],
  ["can_manage_sales", "מכירות"],
];

export default function SettingsView({ profile, showToast }) {
  const { rows: profiles } = useRealtimeList("profiles", { orderBy: "name", ascending: true });

  async function changeRole(id, role) {
    const { error } = await supabase.from("profiles").update({ role }).eq("id", id);
    if (error) showToast("שגיאה בעדכון תפקיד");
  }

  async function toggleFlag(p, flag) {
    const { error } = await supabase.from("profiles").update({ [flag]: !p[flag] }).eq("id", p.id);
    if (error) showToast("אין הרשאה לעדכן");
  }

  return (
    <div>
      <PageHeader icon={Settings} title="הגדרות" subtitle="ניהול משתמשים והרשאות מודולים" />
      <div style={panelStyle}>
        <div style={{ fontSize: 11.5, color: colors.mutedText, marginBottom: 12 }}>
          יצירת משתמש חדש: כרגע דרך Supabase Dashboard → Authentication → Add user, ואז הוספת שורה בטבלת
          profiles עם אותו UID (בדיוק כמו בהקמה הראשונית — ראו SETUP.md). מסך "צור משתמש" מתוך האתר, כמו
          שיש ב-Arizot CRM, דורש פריסת Edge Function נוספת שלא נבנתה עדיין בסבב הזה.
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {profiles.map((p) => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 13, borderBottom: `1px solid ${colors.border}`, paddingBottom: 8 }}>
              <span>{p.name} ({p.username}){p.is_super_admin ? " · סופר-אדמין" : ""}</span>
              {!p.is_super_admin && (
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <select style={{ ...inputStyle, width: 90, padding: 4 }} value={p.role} onChange={(e) => changeRole(p.id, e.target.value)}>
                    <option value="עובד">עובד</option>
                    <option value="מנהל">מנהל</option>
                  </select>
                  {PERMISSION_FLAGS.map(([flag, label]) => (
                    <button
                      key={flag}
                      onClick={() => toggleFlag(p, flag)}
                      style={{
                        border: `1px solid ${p[flag] ? colors.accent : colors.border}`, borderRadius: 6, cursor: "pointer",
                        background: p[flag] ? colors.accent : "#fff", color: p[flag] ? "#fff" : colors.muted, fontSize: 11, padding: "4px 8px",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
