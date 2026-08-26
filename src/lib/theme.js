// Own visual identity — this is a separate product from Arizot Design's CRM, not a reskin of it.
export const colors = {
  bg: "#eef1f5",
  header: "#1f3a5f",
  accent: "#2f7d6b",
  danger: "#b3261e",
  warning: "#b8860b",
  text: "#1c2430",
  muted: "#6b7684",
  mutedText: "#5a6472",
  border: "#d7dce3",
  card: "#ffffff",
};

export const panelStyle = {
  background: colors.card,
  borderRadius: 12,
  padding: 16,
  boxShadow: "0 1px 2px rgba(28,36,48,.04), 0 4px 14px rgba(28,36,48,.06)",
};

export const inputStyle = {
  width: "100%",
  padding: 9,
  borderRadius: 8,
  border: `1px solid ${colors.border}`,
  boxSizing: "border-box",
  fontSize: 14,
  background: "#fff",
};

export const buttonPrimary = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "none",
  background: colors.accent,
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: "0 2px 6px rgba(47,125,107,.3)",
};

export const buttonDanger = { ...buttonPrimary, background: colors.danger, boxShadow: "0 2px 6px rgba(179,38,30,.3)" };
export const buttonGhost = { padding: "8px 16px", borderRadius: 8, border: `1px solid ${colors.border}`, background: "#fff", color: colors.text, cursor: "pointer" };
