import React, { useMemo, useState } from "react";
import { Contact, Clock } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useRealtimeList } from "../lib/useTable";
import { colors, panelStyle, inputStyle, buttonPrimary, buttonGhost } from "../lib/theme";
import { money, fmtDate } from "../lib/format";
import { isManager } from "../lib/permissions";
import PageHeader from "../components/PageHeader";

export default function HRView({ profile, showToast }) {
  const { rows: employees } = useRealtimeList("employees", { orderBy: "name", ascending: true });
  const { rows: attendance } = useRealtimeList("attendance_entries", { orderBy: "clock_in", ascending: false });
  const mgr = isManager(profile);
  const [form, setForm] = useState({ name: "", roleTitle: "", employmentType: "שעתי", hourlyRate: "", monthlySalary: "" });

  const myEmployee = employees.find((e) => e.profile_id === profile.id);
  const myOpenEntry = myEmployee ? attendance.find((a) => a.employee_id === myEmployee.id && !a.clock_out) : null;

  async function addEmployee(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    const { error } = await supabase.from("employees").insert({
      name: form.name, role_title: form.roleTitle || null, employment_type: form.employmentType,
      hourly_rate: form.hourlyRate ? Number(form.hourlyRate) : null, monthly_salary: form.monthlySalary ? Number(form.monthlySalary) : null,
    });
    if (error) { showToast("אין הרשאה להוסיף עובד, או שגיאה"); return; }
    setForm({ name: "", roleTitle: "", employmentType: "שעתי", hourlyRate: "", monthlySalary: "" });
    showToast("העובד נוסף");
  }

  async function clockIn() {
    if (!myEmployee) { showToast("אין לך רשומת עובד מקושרת — פנה למנהל"); return; }
    await supabase.from("attendance_entries").insert({ employee_id: myEmployee.id });
  }
  async function clockOut() {
    if (!myOpenEntry) return;
    await supabase.from("attendance_entries").update({ clock_out: new Date().toISOString() }).eq("id", myOpenEntry.id);
  }

  // Estimate only — see migration header. Sums completed entries' hours per employee this month.
  const estimates = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    return employees.map((emp) => {
      const hours = attendance
        .filter((a) => a.employee_id === emp.id && a.clock_out && new Date(a.clock_in) >= monthStart)
        .reduce((s, a) => s + (new Date(a.clock_out) - new Date(a.clock_in)) / 3600000, 0);
      const estimate = emp.employment_type === "שעתי" ? hours * (emp.hourly_rate || 0) : (emp.monthly_salary || 0);
      return { ...emp, hours, estimate };
    });
  }, [employees, attendance]);

  return (
    <div>
      <PageHeader icon={Contact} title="משאבי אנוש" subtitle={`${employees.length} עובדים`} />

      <div style={{ ...panelStyle, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}><Clock size={16} /> נוכחות שלי</div>
        {myOpenEntry ? (
          <div>
            <div style={{ fontSize: 12.5, color: colors.mutedText, marginBottom: 8 }}>נכנסת ב-{fmtDate(myOpenEntry.clock_in)}</div>
            <button style={buttonPrimary} onClick={clockOut}>יציאה</button>
          </div>
        ) : (
          <button style={buttonPrimary} onClick={clockIn}>כניסה</button>
        )}
      </div>

      {mgr && (
        <form onSubmit={addEmployee} style={{ ...panelStyle, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input style={{ ...inputStyle, width: 160 }} placeholder="שם העובד" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input style={{ ...inputStyle, width: 140 }} placeholder="תפקיד" value={form.roleTitle} onChange={(e) => setForm({ ...form, roleTitle: e.target.value })} />
          <select style={{ ...inputStyle, width: 100 }} value={form.employmentType} onChange={(e) => setForm({ ...form, employmentType: e.target.value })}>
            <option value="שעתי">שעתי</option>
            <option value="חודשי">חודשי</option>
          </select>
          {form.employmentType === "שעתי"
            ? <input type="number" style={{ ...inputStyle, width: 120 }} placeholder="תעריף לשעה" value={form.hourlyRate} onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })} />
            : <input type="number" style={{ ...inputStyle, width: 130 }} placeholder="שכר חודשי" value={form.monthlySalary} onChange={(e) => setForm({ ...form, monthlySalary: e.target.value })} />}
          <button type="submit" style={buttonGhost}>הוספת עובד</button>
        </form>
      )}

      <div style={panelStyle}>
        <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13.5 }}>הערכת שכר החודש (הערכה בלבד — לא תלוש רשמי)</div>
        <div style={{ display: "grid", gap: 4 }}>
          {estimates.map((e) => (
            <div key={e.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0", borderBottom: `1px solid ${colors.border}` }}>
              <span>{e.name} <span style={{ color: colors.muted, fontSize: 11 }}>({e.role_title || e.employment_type})</span></span>
              <span>{e.employment_type === "שעתי" && `${e.hours.toFixed(1)} שעות · `}<strong>{money(e.estimate)}</strong></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
