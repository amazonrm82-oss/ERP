import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ModulesForm } from "@/features/modules/components/modules-form";
import { getOrgModules } from "@/features/modules/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";

export const metadata: Metadata = { title: "מודולים" };

type Props = { params: Promise<{ orgId: string }> };

// LEAD-08: a business that does not work with leads, or with companies, switches the module off.
export default async function ModulesPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const [modules, terms] = await Promise.all([getOrgModules(orgId), getOrgTerms(orgId)]);
  const editable = isAdminRole(context.role) && context.canWrite;
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">
        מודול כבוי יורד מהתפריט, מהמסכים ומהטפסים. שום דבר לא נמחק: כשמפעילים אותו מחדש, כל המידע חוזר להופיע.
      </p>
      {editable ? (
        <Card aria-labelledby="modules-title">
          <CardHeader id="modules-title" title="המודולים של העסק" />
          <CardBody>
            <ModulesForm orgId={orgId} modules={modules} leadsLabel={terms.lead.plural} />
          </CardBody>
        </Card>
      ) : (
        <p className="text-sm text-ink-soft">
          {isAdminRole(context.role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים להפעיל ולכבות מודולים."}
        </p>
      )}
    </div>
  );
}
