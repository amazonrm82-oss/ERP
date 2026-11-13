import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { PrefillFormsEditor } from "@/features/prefill-links/components/prefill-forms-editor";
import { prefillChoices } from "@/features/prefill-links/fields";
import { listPrefillForms, prefillInPlan } from "@/features/prefill-links/queries";
import { prefillRecordLabels } from "@/features/prefill-links/texts";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";

export const metadata: Metadata = { title: "טפסי השלמת פרטים" };

type Props = { params: Promise<{ orgId: string }> };

/**
 * BIZ-05: the forms that fill an existing lead or contact (an intake questionnaire, details before a meeting), sent from the
 * record's page by a personal link. Owners and admins manage them. Never a field marked sensitive (a health form waits for
 * PRV-05).
 */
export default async function PrefillFormsSettings({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isAdminRole(role)) {
    return (
      <Card aria-labelledby="prefill-title">
        <CardHeader id="prefill-title" title="טפסי השלמת פרטים" />
        <CardBody>
          <p className="text-md text-ink-soft">את הטפסים מגדירים בעלי העסק ומנהלי המערכת.</p>
        </CardBody>
      </Card>
    );
  }
  const [forms, leadFields, contactFields, inPlan, terms] = await Promise.all([
    listPrefillForms(orgId),
    listFieldDefinitions(orgId, "lead"),
    listFieldDefinitions(orgId, "contact"),
    prefillInPlan(orgId),
    getOrgTerms(orgId),
  ]);
  return (
    <Card aria-labelledby="prefill-title">
      <CardHeader id="prefill-title" title="טפסי השלמת פרטים" />
      <CardBody className="space-y-4">
        <p className="text-md text-ink-soft">
          טופס ששולחים ללקוח קיים בקישור אישי מהדף שלו: שאלון קליטה, פרטים לפני פגישה. הלקוח רואה את הפרטים שכבר רשומים, משלים
          ומתקן, והתשובות נכנסות לשדות ולציר הזמן. כל קישור בתוקף 14 ימים ולמילוי אחד.
        </p>
        {!inPlan ? (
          <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
            טופס השלמת פרטים אינו כלול בחבילה הנוכחית.
          </p>
        ) : null}
        {canWrite ? (
          <PrefillFormsEditor
            orgId={orgId}
            forms={forms}
            choices={{ lead: prefillChoices("lead", leadFields), contact: prefillChoices("contact", contactFields) }}
            recordLabels={prefillRecordLabels(terms)}
          />
        ) : (
          <p className="text-md text-ink-soft">העסק במצב קריאה בלבד, ולכן אי אפשר לשנות את הטפסים כרגע.</p>
        )}
      </CardBody>
    </Card>
  );
}
