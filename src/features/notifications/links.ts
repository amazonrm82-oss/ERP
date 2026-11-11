import { calendarPath } from "@/features/calendar/range";
import { cleanupPath } from "@/features/data-quality/paths";
import { messageTemplatesPath } from "@/features/message-templates/paths";
import { retentionListPath } from "@/features/lead-retention/paths";
import { orderPath } from "@/features/orders/paths";
import { privacyRequestPath, privacyRequestsPath } from "@/features/privacy-requests/paths";
import { quotePath } from "@/features/quotes/paths";
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
    // a new lead while the business is suspended (0163): choose a plan to see it; the id is the business
    case "subscription":
      return paths.settingsPlan(orgId);
    // QUO-09 / QUO-10: the customer opened, accepted or declined a quote
    case "quote":
      return quotePath(orgId, entityId);
    // ORD-05: the customer approved or declined an order through its link
    case "order":
      return orderPath(orgId, entityId);
    // RVW-50 (HEB-08): an employee picked a deputy for a leave. The id is the leave's, not the employee's, so the
    // notice opens the users list, which every member may see; owners and admins go on from there to the hours page
    case "member_leaves":
      return paths.settingsUsers(orgId);
    // PRV-01: a retention round (its id); the list page shows the open round, or says there is none
    case "lead_retention":
      return retentionListPath(orgId);
    // PRV-01: the round moved its leads to the recycle bin, where they can be restored
    case "lead_retention_binned":
      return paths.settingsTrash(orgId);
    // USR-12 / ADM-05: support changed the status of a request; the support page lists it
    case "support_request":
      return paths.support(orgId);
    // DQL-03: the weekly cleanup suggestions (the id is the business)
    case "cleanup_suggestions":
      return cleanupPath(orgId);
    // PRK-02: a new privacy request (its id); owners and admins open it, the privacy officer is told to turn to them
    case "privacy_request":
      return privacyRequestPath(orgId, entityId);
    // PRK-02: the day's further requests, counted in one notice (the id is the business)
    case "privacy_requests":
      return privacyRequestsPath(orgId);
    // MSG-02 (96): a message from this template was not sent (too long after filling, and the like); the templates page
    case "message_template":
      return messageTemplatesPath(orgId);
    // IMP-04: a background import or export ended (its id); the import page lists it, with the export's download
    case "background_request":
      return paths.imports(orgId);
    // MNY-04: anomaly alerts (the id is the business); each opens the page where the business sees which source, person,
    // form or campaign the count is about
    case "anomaly_lead_drop":
      return paths.report(orgId, "sources");
    case "anomaly_idle_rep":
      return paths.report(orgId, "activity");
    case "anomaly_quiet_form":
      return paths.settingsIntake(orgId);
    case "anomaly_campaign_jump":
      return paths.report(orgId, "campaign_roi");
    default:
      return null;
  }
}
