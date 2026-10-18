import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { NewTemplateForm, TemplateItem } from "@/features/task-checklists/components/template-forms";
import { listChecklistTemplates } from "@/features/task-checklists/queries";

export const metadata: Metadata = { title: "תבניות רשימת תיוג" };

type Props = { params: Promise<{ orgId: string }> };

// the database's cap (app.checklist_templates_cap)
const TEMPLATES_PER_ORG = 50;

/** TASK-06: named step lists that go into a task in one tap. Everyone reads them; owners and admins edit. */
export default async function ChecklistTemplatesPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const templates = await listChecklistTemplates(orgId);

  return (
    <div className="space-y-6">
      <Card aria-labelledby="checklists-title">
        <CardHeader id="checklists-title" title="תבניות רשימת תיוג" />
        <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
          <p>תבנית היא רשימת שלבים קבועה, כמו &quot;קליטת לקוח&quot;. במשימה בוחרים תבנית, והשלבים שלה נכנסים למשימה ומסמנים אותם אחד אחד.</p>
          <p>שינוי בתבנית לא משנה משימות שכבר קיבלו את השלבים שלה.</p>
        </CardBody>
        {templates.length > 0 ? (
          <ul className="mt-3 divide-y divide-line border-t border-line">
            {templates.map((template) => (
              <li key={template.id} className="px-4 py-4 sm:px-5">
                <TemplateItem orgId={orgId} template={template} editable={editable} />
              </li>
            ))}
          </ul>
        ) : (
          <CardBody className="mt-3 border-t border-line">
            <p className="text-md text-ink-soft">אין תבניות. אפשר להוסיף שלבים לכל משימה גם בלי תבנית.</p>
          </CardBody>
        )}
      </Card>
      {editable && templates.length < TEMPLATES_PER_ORG ? (
        <Card aria-labelledby="checklist-new">
          <CardHeader id="checklist-new" title="תבנית חדשה" />
          <CardBody>
            <NewTemplateForm orgId={orgId} />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
