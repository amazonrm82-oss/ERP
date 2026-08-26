import React, { useMemo, useState } from "react";
import { BookOpen, Plus, Trash2 } from "lucide-react";
import { useRealtimeList } from "../lib/useTable";
import { useFinanceActions } from "../lib/financeActions";
import { colors, panelStyle, inputStyle, buttonPrimary, buttonGhost } from "../lib/theme";
import { money, fmtDate } from "../lib/format";
import PageHeader from "../components/PageHeader";

const BLANK_LINE = () => ({ accountId: "", debit: "", credit: "" });

export default function LedgerView({ profile, showToast }) {
  const { rows: accounts } = useRealtimeList("gl_accounts", { orderBy: "code", ascending: true });
  const { rows: transactions } = useRealtimeList("gl_transactions", { orderBy: "txn_date", ascending: false });
  const { rows: lines } = useRealtimeList("gl_lines", { orderBy: "id", ascending: true });
  const actions = useFinanceActions(showToast, profile);

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [entryLines, setEntryLines] = useState([BLANK_LINE(), BLANK_LINE()]);

  const totalDebit = entryLines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = entryLines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

  function updateLine(i, patch) {
    setEntryLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function submit(e) {
    e.preventDefault();
    if (!description.trim()) { showToast("יש להזין תיאור לתנועה"); return; }
    const validLines = entryLines.filter((l) => l.accountId && (Number(l.debit) || Number(l.credit)));
    if (!balanced || validLines.length < 2) { showToast("התנועה חייבת לפחות 2 שורות מאוזנות (חובה = זכות)"); return; }
    const txn = await actions.postJournalEntry(date, description, validLines);
    if (txn) { setDescription(""); setEntryLines([BLANK_LINE(), BLANK_LINE()]); }
  }

  // Trial balance: net balance per account = sum(debit) - sum(credit) across all lines.
  const balances = useMemo(() => {
    const map = new Map();
    for (const l of lines) {
      const cur = map.get(l.account_id) || 0;
      map.set(l.account_id, cur + Number(l.debit || 0) - Number(l.credit || 0));
    }
    return accounts.map((a) => ({ ...a, balance: map.get(a.id) || 0 })).filter((a) => a.balance !== 0);
  }, [accounts, lines]);

  function accountLabel(id) { const a = accounts.find((x) => x.id === id); return a ? `${a.code} · ${a.name}` : "—"; }

  return (
    <div>
      <PageHeader icon={BookOpen} title="הנהלת חשבונות" subtitle={`${accounts.length} חשבונות · ${transactions.length} תנועות`} />

      <form onSubmit={submit} style={{ ...panelStyle, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13.5 }}>תנועת יומן חדשה</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <input type="date" style={{ ...inputStyle, width: 150 }} value={date} onChange={(e) => setDate(e.target.value)} />
          <input style={{ ...inputStyle, flex: 1, minWidth: 200 }} placeholder="תיאור התנועה" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {entryLines.map((line, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
            <select style={{ ...inputStyle, flex: 1 }} value={line.accountId} onChange={(e) => updateLine(i, { accountId: e.target.value })}>
              <option value="">בחר חשבון…</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </select>
            <input type="number" style={{ ...inputStyle, width: 100 }} placeholder="חובה" value={line.debit} onChange={(e) => updateLine(i, { debit: e.target.value, credit: "" })} />
            <input type="number" style={{ ...inputStyle, width: 100 }} placeholder="זכות" value={line.credit} onChange={(e) => updateLine(i, { credit: e.target.value, debit: "" })} />
            {entryLines.length > 2 && (
              <button type="button" onClick={() => setEntryLines((ls) => ls.filter((_, idx) => idx !== i))} style={{ border: "none", background: "none", color: colors.danger, cursor: "pointer" }}>
                <Trash2 size={16} />
              </button>
            )}
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
          <button type="button" onClick={() => setEntryLines((ls) => [...ls, BLANK_LINE()])} style={{ ...buttonGhost, display: "flex", alignItems: "center", gap: 4, fontSize: 12.5 }}>
            <Plus size={14} /> שורה נוספת
          </button>
          <div style={{ fontSize: 12.5, color: balanced ? colors.accent : colors.danger, fontWeight: 700 }}>
            חובה {money(totalDebit)} · זכות {money(totalCredit)} {balanced ? "✓ מאוזן" : "· לא מאוזן"}
          </div>
        </div>
        <button type="submit" style={{ ...buttonPrimary, marginTop: 10 }}>רישום תנועה</button>
      </form>

      <div style={{ ...panelStyle, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13.5 }}>מאזן בוחן (יתרות פתוחות)</div>
        <div style={{ display: "grid", gap: 4 }}>
          {balances.map((a) => (
            <div key={a.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0", borderBottom: `1px solid ${colors.border}` }}>
              <span>{a.code} · {a.name} <span style={{ color: colors.muted, fontSize: 11 }}>({a.type})</span></span>
              <span style={{ fontWeight: 700 }}>{money(a.balance)}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={panelStyle}>
        <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13.5 }}>תנועות אחרונות</div>
        <div style={{ display: "grid", gap: 8 }}>
          {transactions.slice(0, 20).map((t) => (
            <div key={t.id} style={{ fontSize: 12.5, borderBottom: `1px solid ${colors.border}`, paddingBottom: 6 }}>
              <div><strong>{t.description}</strong> · {fmtDate(t.txn_date)}</div>
              <div style={{ color: colors.mutedText }}>
                {lines.filter((l) => l.transaction_id === t.id).map((l) => `${accountLabel(l.account_id)}: ${l.debit > 0 ? "חובה " + money(l.debit) : "זכות " + money(l.credit)}`).join(" | ")}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
