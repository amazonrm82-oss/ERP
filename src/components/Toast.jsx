import React from "react";
import { colors } from "../lib/theme";

export default function Toast({ message }) {
  if (!message) return null;
  return (
    <div style={{
      position: "fixed", bottom: 20, insetInlineStart: "50%", transform: "translateX(-50%)",
      background: colors.text, color: "#fff", padding: "10px 18px", borderRadius: 10,
      fontSize: 13.5, boxShadow: "0 4px 16px rgba(0,0,0,.2)", zIndex: 1000,
    }}>
      {message}
    </div>
  );
}
