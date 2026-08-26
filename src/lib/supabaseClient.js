import { createClient } from "@supabase/supabase-js";

// This is a fully independent system — its own Supabase project, not the Arizot CRM's. Create a
// new project at https://supabase.com/dashboard, then set these two values (Project Settings ->
// API) either directly here or via a .env file (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). See
// SETUP.md.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // eslint-disable-next-line no-console
  console.warn("Supabase לא מוגדר — ראה SETUP.md ליצירת פרויקט Supabase חדש ועצמאי.");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
