import { buttonClasses } from "@/components/ui/button";
import { paths } from "@/lib/paths";

/**
 * PRV-02: owners and admins download everything the business holds about this person (a request to see one's data).
 * A plain link: the route answers with a ZIP, and the download is written to the audit log.
 */
export function PersonExportLink({ orgId, kind, id }: { orgId: string; kind: "lead" | "contact"; id: string }) {
  return (
    <a
      href={paths.personExport(orgId, kind, id)}
      download
      className={buttonClasses("secondary", "sm")}
      title="קובץ אחד עם הרשומה, ציר הזמן, הקבצים, הצעות המחיר וההסכמות. ההורדה נרשמת ביומן הפעולות."
    >
      ייצוא כל המידע על האדם
    </a>
  );
}
