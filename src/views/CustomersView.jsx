import React, { useState } from "react";
import { Users } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useRealtimeList } from "../lib/useTable";
import { colors, panelStyle, inputStyle, buttonPrimary } from "../lib/theme";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";

export default function CustomersView() {
  const { rows: customers } = useRealtimeList("customers", { orderBy: "name", ascending: true });
  const [form, setForm] = useState({ name: "", business_name: "", phone: "", email: "" });

  async function addCustomer(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    await supabase.from("customers").insert(form);
    setForm({ name: "", business_name: "", phone: "", email: "" });
  }

  return (
    <div>
      <PageHeader icon={Users} title="לקוחות" subtitle={`${customers.length} לקוחות`} />
      <form onSubmit={addCustomer} style={{ ...panelStyle, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input style={{ ...inputStyle, width: 160 }} placeholder="שם" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input style={{ ...inputStyle, width: 160 }} placeholder="שם עסק" value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
        <input style={{ ...inputStyle, width: 140 }} placeholder="טלפון" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <input style={{ ...inputStyle, width: 180 }} placeholder="אימייל" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <button type="submit" style={buttonPrimary}>הוספת לקוח</button>
      </form>
      {customers.length === 0 ? <EmptyState icon={Users} text="אין עדיין לקוחות" /> : (
        <div style={{ display: "grid", gap: 8 }}>
          {customers.map((c) => (
            <div key={c.id} style={panelStyle}>
              <div style={{ fontWeight: 700 }}>{c.name}{c.business_name ? ` · ${c.business_name}` : ""}</div>
              <div style={{ fontSize: 12.5, color: colors.mutedText }}>{c.phone} {c.email ? `· ${c.email}` : ""}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
