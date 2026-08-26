// Mirrors the RLS rules in supabase/migrations/0001_init.sql — the database is the real
// enforcement layer, nothing here needs to be trusted for security. Independent system, so its
// own (simpler) two-role model: this back office doesn't need Arizot's sales-team role split.
export function isManager(profile) {
  return !!profile && (profile.is_super_admin || profile.role === "מנהל");
}
