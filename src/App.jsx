import React, { useEffect, useState } from "react";
import { supabase } from "./lib/supabaseClient";
import LoginScreen from "./components/LoginScreen";
import { colors } from "./lib/theme";

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = not checked yet
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); return; }
    supabase.from("profiles").select("*").eq("id", session.user.id).single()
      .then(({ data }) => setProfile(data || null));
  }, [session]);

  if (session === undefined) {
    return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: colors.text }}>טוען…</div>;
  }
  if (!session) return <LoginScreen />;
  if (!profile) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", color: colors.text }}>
        החשבון מחובר אך אין לו פרופיל במערכת. יש לפנות למנהל כדי שייצור עבורך משתמש.
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: colors.bg, color: colors.text }}>
      שלום {profile.name} — המסכים הראשיים (כספים, רכש ומלאי, שיווק, שירות, כוח אדם) ייבנו כאן בהמשך.
    </div>
  );
}
