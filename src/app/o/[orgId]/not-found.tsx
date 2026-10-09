import { EmptyState } from "@/components/ui/feedback";

// A missing record inside the app keeps the shell on screen; the navigation is
// the way out. (An unknown or inaccessible organization gets the root 404.)
export default function OrgNotFound() {
  return (
    <div className="rounded-lg border border-line bg-surface">
      <h1 className="sr-only">הרשומה לא נמצאה</h1>
      <EmptyState kind="search"
        title="הרשומה לא נמצאה"
        description="ייתכן שהקישור שגוי, שהרשומה הועברה לסל המחזור, או שאין לך גישה אליה."
      />
    </div>
  );
}
