import React, { useState } from "react";
import { LifeBuoy, Send } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useRealtimeList } from "../lib/useTable";
import { colors, panelStyle, inputStyle, buttonPrimary, buttonGhost } from "../lib/theme";
import { fmtDate } from "../lib/format";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";

const STATUSES = ["פתוח", "בטיפול", "סגור"];

export default function SupportView({ profile, showToast }) {
  const { rows: tickets } = useRealtimeList("support_tickets", { orderBy: "created_at", ascending: false });
  const { rows: customers } = useRealtimeList("customers", { orderBy: "name", ascending: true });
  const { rows: messages } = useRealtimeList("ticket_messages", { orderBy: "created_at", ascending: true });
  const [form, setForm] = useState({ customerId: "", subject: "", priority: "רגילה" });
  const [openTicket, setOpenTicket] = useState(null);
  const [reply, setReply] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!form.subject.trim()) { showToast("יש להזין נושא"); return; }
    const { error } = await supabase.from("support_tickets").insert({
      customer_id: form.customerId || null, subject: form.subject, priority: form.priority, created_by: profile.id,
    });
    if (error) { showToast("שגיאה בפתיחת פנייה"); return; }
    setForm({ customerId: "", subject: "", priority: "רגילה" });
    showToast("הפנייה נפתחה");
  }

  async function setStatus(t, status) { await supabase.from("support_tickets").update({ status }).eq("id", t.id); }

  async function sendReply(ticketId) {
    if (!reply.trim()) return;
    await supabase.from("ticket_messages").insert({ ticket_id: ticketId, author_id: profile.id, text: reply.trim() });
    setReply("");
  }

  function customerName(id) { return customers.find((c) => c.id === id)?.name || "—"; }
  const openTickets = tickets.filter((t) => t.status !== "סגור");

  return (
    <div>
      <PageHeader icon={LifeBuoy} title="שירות לקוחות" subtitle={`${openTickets.length} פניות פתוחות`} />

      <form onSubmit={submit} style={{ ...panelStyle, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select style={{ ...inputStyle, width: 160 }} value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
          <option value="">לקוח (אופציונלי)…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input style={{ ...inputStyle, flex: 1, minWidth: 200 }} placeholder="נושא הפנייה" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        <select style={{ ...inputStyle, width: 110 }} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
          <option value="נמוכה">עדיפות נמוכה</option>
          <option value="רגילה">עדיפות רגילה</option>
          <option value="גבוהה">עדיפות גבוהה</option>
        </select>
        <button type="submit" style={buttonPrimary}>פתיחת פנייה</button>
      </form>

      {tickets.length === 0 ? <EmptyState icon={LifeBuoy} text="אין עדיין פניות" /> : (
        <div style={{ display: "grid", gap: 8 }}>
          {tickets.map((t) => (
            <div key={t.id} style={{ ...panelStyle, border: t.priority === "גבוהה" && t.status !== "סגור" ? `1.5px solid ${colors.danger}` : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", cursor: "pointer", flexWrap: "wrap", gap: 8 }} onClick={() => setOpenTicket(openTicket === t.id ? null : t.id)}>
                <div>
                  <div style={{ fontWeight: 700 }}>{t.subject}</div>
                  <div style={{ fontSize: 12, color: colors.mutedText }}>{customerName(t.customer_id)} · {fmtDate(t.created_at)} · עדיפות {t.priority}</div>
                </div>
                <select style={{ ...inputStyle, width: 100, padding: 4 }} value={t.status} onClick={(e) => e.stopPropagation()} onChange={(e) => setStatus(t, e.target.value)}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              {openTicket === t.id && (
                <div style={{ marginTop: 10, borderTop: `1px solid ${colors.border}`, paddingTop: 10 }}>
                  <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
                    {messages.filter((m) => m.ticket_id === t.id).map((m) => (
                      <div key={m.id} style={{ fontSize: 12.5, background: colors.bg, borderRadius: 8, padding: "6px 10px" }}>{m.text}</div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input style={inputStyle} placeholder="תגובה…" value={reply} onChange={(e) => setReply(e.target.value)} />
                    <button style={buttonGhost} onClick={() => sendReply(t.id)}><Send size={14} /></button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
