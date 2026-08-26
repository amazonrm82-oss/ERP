import React, { useState } from "react";
import { FolderKanban, Plus } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useRealtimeList } from "../lib/useTable";
import { colors, panelStyle, inputStyle, buttonPrimary, buttonGhost } from "../lib/theme";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";

export default function ProjectsView({ profile, showToast }) {
  const { rows: projects } = useRealtimeList("projects", { orderBy: "created_at", ascending: false });
  const { rows: customers } = useRealtimeList("customers", { orderBy: "name", ascending: true });
  const { rows: milestones } = useRealtimeList("project_milestones", { orderBy: "sort_order", ascending: true });
  const [form, setForm] = useState({ name: "", customerId: "" });
  const [milestoneForm, setMilestoneForm] = useState({});
  const [openProject, setOpenProject] = useState(null);

  async function addProject(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    const { error } = await supabase.from("projects").insert({ name: form.name, customer_id: form.customerId || null, created_by: profile.id });
    if (error) { showToast("שגיאה ביצירת פרויקט"); return; }
    setForm({ name: "", customerId: "" });
    showToast("הפרויקט נוצר");
  }

  async function addMilestone(projectId) {
    const draft = milestoneForm[projectId];
    if (!draft?.title?.trim()) return;
    const count = milestones.filter((m) => m.project_id === projectId).length;
    await supabase.from("project_milestones").insert({ project_id: projectId, title: draft.title, due_date: draft.dueDate || null, sort_order: count });
    setMilestoneForm({ ...milestoneForm, [projectId]: { title: "", dueDate: "" } });
  }

  async function toggleMilestone(m) { await supabase.from("project_milestones").update({ done: !m.done }).eq("id", m.id); }

  function customerName(id) { return customers.find((c) => c.id === id)?.name; }

  return (
    <div>
      <PageHeader icon={FolderKanban} title="ניהול פרויקטים" subtitle={`${projects.length} פרויקטים`} />

      <form onSubmit={addProject} style={{ ...panelStyle, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input style={{ ...inputStyle, flex: 1, minWidth: 180 }} placeholder="שם הפרויקט" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select style={{ ...inputStyle, width: 180 }} value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
          <option value="">לקוח (אופציונלי)…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button type="submit" style={buttonPrimary}>יצירת פרויקט</button>
      </form>

      {projects.length === 0 ? <EmptyState icon={FolderKanban} text="אין עדיין פרויקטים" /> : (
        <div style={{ display: "grid", gap: 8 }}>
          {projects.map((p) => {
            const ms = milestones.filter((m) => m.project_id === p.id);
            const done = ms.filter((m) => m.done).length;
            return (
              <div key={p.id} style={panelStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setOpenProject(openProject === p.id ? null : p.id)}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{p.name}{customerName(p.customer_id) ? ` · ${customerName(p.customer_id)}` : ""}</div>
                    <div style={{ fontSize: 12, color: colors.mutedText }}>{p.status} · {done}/{ms.length} אבני דרך הושלמו</div>
                  </div>
                </div>
                {openProject === p.id && (
                  <div style={{ marginTop: 10, borderTop: `1px solid ${colors.border}`, paddingTop: 10 }}>
                    <div style={{ display: "grid", gap: 4, marginBottom: 8 }}>
                      {ms.map((m) => (
                        <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, textDecoration: m.done ? "line-through" : "none", color: m.done ? colors.muted : colors.text }}>
                          <input type="checkbox" checked={m.done} onChange={() => toggleMilestone(m)} />
                          {m.title} {m.due_date ? `· ${m.due_date}` : ""}
                        </label>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input style={{ ...inputStyle, flex: 1 }} placeholder="אבן דרך חדשה" value={milestoneForm[p.id]?.title || ""} onChange={(e) => setMilestoneForm({ ...milestoneForm, [p.id]: { ...milestoneForm[p.id], title: e.target.value } })} />
                      <input type="date" style={{ ...inputStyle, width: 150 }} value={milestoneForm[p.id]?.dueDate || ""} onChange={(e) => setMilestoneForm({ ...milestoneForm, [p.id]: { ...milestoneForm[p.id], dueDate: e.target.value } })} />
                      <button style={buttonGhost} onClick={() => addMilestone(p.id)}><Plus size={14} /></button>
                    </div>
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
