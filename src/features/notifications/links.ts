import { calendarPath } from "@/features/calendar/range";
import { documentSettingsPath } from "@/features/tax/paths";
import { paths } from "@/lib/paths";

/** Where a notification leads: the record it is about, or nowhere. */
export function notificationHref(orgId: string, entityType: string | null, entityId: string | null): string | null {
  if (!entityId) {
    return null;
  }
  switch (entityType) {
    case "lead":
      return paths.lead(orgId, entityId);
    case "contact":
      return paths.contact(orgId, entityId);
    case "company":
      return paths.company(orgId, entityId);
    case "deal":
      return paths.deal(orgId, entityId);
    case "task":
      return paths.tasks(orgId);
    // the agenda starts today, so an upcoming meeting is on it
    case "meeting":
      return calendarPath(orgId, { view: "agenda" });
    // the rule's page, with its run log (automation_failed)
    case "automation":
      return paths.settingsAutomation(orgId, entityId);
    // TAX-02 follow-up: a change of the bank details, seen by owners and admins
    case "org_bank_details":
      return documentSettingsPath(orgId);
    default:
      return null;
  }
}
