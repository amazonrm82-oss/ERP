import React, { useState } from "react";
import { TrendingUp, Plus, Trash2 } from "lucide-react";
import { useRealtimeList } from "../lib/useTable";
import { useSalesActions } from "../lib/salesActions";
import { colors, panelStyle, inputStyle, buttonPrimary, buttonGhost } from "../lib/theme";
import { money, fmtDate } from "../lib/format";
import PageHeader from "../components/PageHeader";

const LEAD_STATUSES = ["חדש", "במגע", "הצעת מחיר", "נסגר", "לא רלוונטי"];
const ORDER_NEXT = { "פתוחה": "בייצור", "בייצור": "נשלחה", "נשלחה": "נסגרה" };
const BLANK_LINE = () => ({ description: "", qty: "", unitPrice: "" });

export default function SalesView({ profile, showToast }) {
  const { rows: leads } = useRealtimeList("sales_leads", { orderBy: "created_at", ascending: false });
  const { rows: customers } = useRealtimeList("customers", { orderBy: "name", ascending: true });
  const { rows: quotes } = useRealtimeList("quotes", { orderBy: "created_at", ascending: false });
  const { rows: quoteLines } = useRealtimeList("quote_lines", { orderBy: "id", ascending: true });
  const { rows: orders } = useRealtimeList("sales_orders", { orderBy: "created_at", ascending: false });
  const { rows: orderLines } = useRealtimeList("sales_order_lines", { orderBy: "id", ascending: true });
  const actions = useSalesActions(showToast, profile);

  const [leadForm, setLeadForm] = useState({ contactName: "", phone: "", source: "" });
  const [quoteForm, setQuoteForm] = useState({ leadId: "", customerId: "", lines: [BLANK_LINE()] });

  async function submitLead(e) {
    e.preventDefault();
    await actions.addLead(leadForm.contactName, leadForm.phone, leadForm.source);
    setLeadForm({ contactName: "", phone: "", source: "" });
  }

  async function submitQuote(e) {
    e.preventDefault();
    const q = await actions.createQuote(quoteForm.leadId, quoteForm.customerId, quoteForm.lines);
    if (q) setQuoteForm({ leadId: "", customerId: "", lines: [BLANK_LINE()] });
  }

  function customerName(id) { return customers.find((c) => c.id === id)?.name || "—"; }
  function linesForQuote(id) { return quoteLines.filter((l) => l.quote_id === id); }
  function linesForOrder(id) { return orderLines.filter((l) => l.order_id === id); }
  function quoteTotal(id) { return linesForQuote(id).reduce((s, l) => s + l.qty * l.unit_price, 0); }
  function orderTotal(id) { return linesForOrder(id).reduce((s, l) => s + l.qty * l.unit_price, 0); }

  return (
    <div>
      <PageHeader icon={TrendingUp} title="מכירות ו-CRM" subtitle={`${leads.length} לידים · ${orders.length} הזמנות`} />

      <div style={{ ...panelStyle, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13.5 }}>לידים</div>
        <form onSubmit={submitLead} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <input style={{ ...inputStyle, width: 160 }} placeholder="שם איש קשר" value={leadForm.contactName} onChange={(e) => setLeadForm({ ...leadForm, contactName: e.target.value })} />
          <input style={{ ...inputStyle, width: 140 }} placeholder="טלפון" value={leadForm.phone} onChange={(e) => setLeadForm({ ...leadForm, phone: e.target.value })} />
          <input style={{ ...inputStyle, width: 140 }} placeholder="מקור" value={leadForm.source} onChange={(e) => setLeadForm({ ...leadForm, source: e.target.value })} />
          <button type="submit" style={buttonGhost}>הוספת ליד</button>
        </form>
        <div style={{ display: "grid", gap: 4 }}>
          {leads.map((l) => (
            <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, borderBottom: `1px solid ${colors.border}`, padding: "4px 0" }}>
              <span>{l.contact_name} {l.phone ? `· ${l.phone}` : ""}</span>
              <select style={{ ...inputStyle, width: 120, padding: 4 }} value={l.status} onChange={(e) => actions.updateLeadStatus(l, e.target.value)}>
                {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>

      <form onSubmit={submitQuote} style={{ ...panelStyle, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13.5 }}>הצעת מחיר חדשה</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <select style={{ ...inputStyle, width: 180 }} value={quoteForm.leadId} onChange={(e) => setQuoteForm({ ...quoteForm, leadId: e.target.value })}>
            <option value="">קישור לליד (אופציונלי)…</option>
            {leads.map((l) => <option key={l.id} value={l.id}>{l.contact_name}</option>)}
          </select>
          <select style={{ ...inputStyle, width: 180 }} value={quoteForm.customerId} onChange={(e) => setQuoteForm({ ...quoteForm, customerId: e.target.value })}>
            <option value="">לקוח (נדרש כדי להמיר להזמנה)…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {quoteForm.lines.map((line, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input style={{ ...inputStyle, flex: 1 }} placeholder="תיאור" value={line.description} onChange={(e) => setQuoteForm((f) => ({ ...f, lines: f.lines.map((l, idx) => idx === i ? { ...l, description: e.target.value } : l) }))} />
            <input type="number" style={{ ...inputStyle, width: 90 }} placeholder="כמות" value={line.qty} onChange={(e) => setQuoteForm((f) => ({ ...f, lines: f.lines.map((l, idx) => idx === i ? { ...l, qty: e.target.value } : l) }))} />
            <input type="number" style={{ ...inputStyle, width: 110 }} placeholder="מחיר ליחידה" value={line.unitPrice} onChange={(e) => setQuoteForm((f) => ({ ...f, lines: f.lines.map((l, idx) => idx === i ? { ...l, unitPrice: e.target.value } : l) }))} />
            {quoteForm.lines.length > 1 && (
              <button type="button" onClick={() => setQuoteForm((f) => ({ ...f, lines: f.lines.filter((_, idx) => idx !== i) }))} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer" }}><Trash2 size={16} /></button>
            )}
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <button type="button" onClick={() => setQuoteForm((f) => ({ ...f, lines: [...f.lines, BLANK_LINE()] }))} style={{ ...buttonGhost, display: "flex", alignItems: "center", gap: 4, fontSize: 12.5 }}><Plus size={14} /> שורה נוספת</button>
          <button type="submit" style={buttonPrimary}>יצירת הצעת מחיר</button>
        </div>
      </form>

      {quotes.length > 0 && (
        <div style={{ ...panelStyle, marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13.5 }}>הצעות מחיר</div>
          <div style={{ display: "grid", gap: 8 }}>
            {quotes.map((q) => (
              <div key={q.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, borderBottom: `1px solid ${colors.border}`, paddingBottom: 6 }}>
                <span>{customerName(q.customer_id)} · {money(quoteTotal(q.id))} · {fmtDate(q.created_at)}</span>
                <button style={buttonGhost} onClick={() => actions.convertQuoteToOrder(q, linesForQuote(q.id), q.customer_id)}>המרה להזמנת מכירה</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={panelStyle}>
        <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13.5 }}>הזמנות מכירה</div>
        <div style={{ display: "grid", gap: 8 }}>
          {orders.map((o) => (
            <div key={o.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, borderBottom: `1px solid ${colors.border}`, paddingBottom: 8 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{customerName(o.customer_id)} · {money(orderTotal(o.id))}</div>
                <div style={{ fontSize: 11.5, color: colors.mutedText }}>{o.status}</div>
              </div>
              {ORDER_NEXT[o.status] && <button style={buttonPrimary} onClick={() => actions.advanceOrderStatus(o, ORDER_NEXT[o.status])}>קידום ל: {ORDER_NEXT[o.status]}</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
