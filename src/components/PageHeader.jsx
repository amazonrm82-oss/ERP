import React from "react";
import { colors } from "../lib/theme";

export default function PageHeader({ icon, title, subtitle, actions }) {
  const Icon = icon;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {Icon && (
          <div style={{ width: 36, height: 36, borderRadius: 10, background: `${colors.accent}17`, color: colors.accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Icon size={18} />
          </div>
        )}
        <div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12.5, color: colors.mutedText, marginTop: 1 }}>{subtitle}</div>}
        </div>
      </div>
      {actions && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>}
    </div>
  );
}
