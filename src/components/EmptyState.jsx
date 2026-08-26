import React from "react";
import { colors } from "../lib/theme";

export default function EmptyState({ icon, text }) {
  const Icon = icon;
  return (
    <div style={{ textAlign: "center", padding: "40px 20px", color: colors.muted }}>
      {Icon && <Icon size={32} style={{ marginBottom: 8, opacity: 0.5 }} />}
      <div style={{ fontSize: 13.5 }}>{text}</div>
    </div>
  );
}
