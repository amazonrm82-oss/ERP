import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "./lib/supabaseClient";
import LoginScreen from "./components/LoginScreen";
import Sidebar from "./components/Sidebar";
import Toast from "./components/Toast";
import { colors } from "./lib/theme";
import CustomersView from "./views/CustomersView";
import InvoicesView from "./views/InvoicesView";
import LedgerView from "./views/LedgerView";
import PayablesView from "./views/PayablesView";
import InventoryView from "./views/InventoryView";
import ProcurementView from "./views/ProcurementView";
import ManufacturingView from "./views/ManufacturingView";
import SalesView from "./views/SalesView";

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

  return <MainApp profile={profile} />;
}

function MainApp({ profile }) {
  const [view, setView] = useState("home");
  const [toast, setToast] = useState(null);
  const showToast = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(null), 2800); }, []);

  const commonProps = { profile, showToast };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: colors.bg }}>
      <Sidebar profile={profile} view={view} setView={setView} />
      <div style={{ flex: 1, minWidth: 0, padding: 24 }}>
        <ViewRouter view={view} {...commonProps} />
      </div>
      <Toast message={toast} />
    </div>
  );
}

function ViewRouter({ view, ...props }) {
  if (view === "home") {
    return (
      <div style={{ color: colors.text }}>
        <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>שלום {props.profile.name}</div>
        <div style={{ fontSize: 13.5, color: colors.mutedText }}>בחרו מסך מהתפריט. מודולים נוספים (רכש, מלאי, ייצור, שירות, כ״א) יתווספו כאן בהמשך.</div>
      </div>
    );
  }
  if (view === "customers") return <CustomersView {...props} />;
  if (view === "invoices") return <InvoicesView {...props} />;
  if (view === "ledger") return <LedgerView {...props} />;
  if (view === "payables") return <PayablesView {...props} />;
  if (view === "inventory") return <InventoryView {...props} />;
  if (view === "procurement") return <ProcurementView {...props} />;
  if (view === "manufacturing") return <ManufacturingView {...props} />;
  if (view === "sales") return <SalesView {...props} />;
  return null;
}
