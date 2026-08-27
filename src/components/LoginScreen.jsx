import React, { useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { colors, inputStyle, buttonPrimary } from "../lib/theme";

export default function LoginScreen() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Supabase Auth authenticates by email under the hood, but the login form takes a username —
  // email_for_username() (0001_init.sql) resolves it first, same pattern as arizot-crm-web.
  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const { data: resolvedEmail, error: lookupErr } = await supabase.rpc("email_for_username", { p_username: username.trim() });
    if (lookupErr || !resolvedEmail) {
      setBusy(false);
      setError("שם משתמש או סיסמה שגויים");
      return;
    }
    const { error: err } = await supabase.auth.signInWithPassword({ email: resolvedEmail, password });
    setBusy(false);
    if (err) setError("שם משתמש או סיסמה שגויים");
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: colors.bg }}>
      <form onSubmit={handleSubmit} style={{ background: colors.card, borderRadius: 14, padding: 32, width: 320, boxShadow: "0 4px 20px rgba(0,0,0,.08)" }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: colors.header, marginBottom: 4 }}>ERP</div>
        <div style={{ fontSize: 13, color: colors.mutedText, marginBottom: 20 }}>מערכת ניהול עצמאית</div>
        <input style={{ ...inputStyle, marginBottom: 10 }} type="text" placeholder="שם משתמש" value={username} onChange={(e) => setUsername(e.target.value)} required />
        <input style={{ ...inputStyle, marginBottom: 14 }} type="password" placeholder="סיסמה" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div style={{ color: colors.danger, fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ ...buttonPrimary, width: "100%" }}>{busy ? "מתחבר…" : "התחברות"}</button>
      </form>
    </div>
  );
}
