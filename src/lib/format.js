export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("he-IL") + " " + d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

export function money(n) {
  return "₪" + (Number(n) || 0).toLocaleString("he-IL", { maximumFractionDigits: 2 });
}
