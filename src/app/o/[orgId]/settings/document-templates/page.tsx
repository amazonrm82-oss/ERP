import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { FormIcon } from "@/components/ui/icons";
import { DocumentTemplatePreview } from "@/features/document-templates/components/template-preview";
import { AddDocumentTemplateForm, DocumentTemplateList, type RecordTypeLabels } from "@/features/document-templates/components/templates-editor";
import { listDocumentTemplates } from "@/features/document-templates/queries";
import { DOCUMENT_TEMPLATES_PER_ORG } from "@/features/document-templates/templates";
import { businessDocumentValues } from "@/features/document-templates/values";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { getDocumentDetails } from "@/features/tax/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { VARIANT_EXAMPLE } from "@/features/whatsapp/variants";
import { must } from "@/lib/db-read";
import { zoneDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "תבניות מסמך" };

type Props = { params: Promise<{ orgId: string }> };

/**
 * SGN-01: the business's document templates (contract, service agreement, joining form; owner (202) ב: no seeded health declaration). Owners and
 * admins of a business whose plan holds `signatures` edit them; every member reads them and previews one on a record.
 */
export default async function DocumentTemplatesPage({ params }: Props) {
  const { orgId } = await params;
  const supabase = await createClient();
  const [context, templates, details, terms, inPlan, org] = await Promise.all([
    getOrgContext(orgId),
    listDocumentTemplates(orgId),
    getDocumentDetails(orgId),
    getOrgTerms(orgId),
    orgHasFeature(orgId, "signatures"),
    supabase.from("organizations").select("phone").eq("id", orgId).maybeSingle(),
  ]);
  const orgPhone = must(org, "organization phone")?.phone ?? null;
  const manageable = isAdminRole(context.role) && context.canWrite;
  const editable = manageable && inPlan;
  // owner (201) ב: without the key owners and admins may still switch a template off and delete it
  const removable = manageable && !inPlan;
  const labels: RecordTypeLabels = {
    lead: terms.lead.singular,
    contact: terms.contact.singular,
    company: "חברה",
    deal: terms.deal.singular,
  };
  const business = businessDocumentValues({
    name: context.org.name,
    legalName: details.legalName,
    taxId: details.taxId,
    addressLine: details.addressLine,
    city: details.city,
    phone: details.phone?.trim() || orgPhone,
    email: details.email,
    userName: context.user.displayName,
    today: zoneDate(new Date(), context.org.timeZone),
  });

  return (
    <div className="space-y-4">
      <Card aria-labelledby="document-templates-title">
        <CardHeader id="document-templates-title" title="תבניות מסמך" />
        <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
          <p>
            נוסחים מוכנים למסמכים כמו חוזה, הסכם שירות וטופס הצטרפות. כל תבנית מתמלאת מתוך רשומה אחת: השדות שבסוגריים מסולסלים מוחלפים
            בפרטים של הרשומה ושל העסק.
          </p>
          <p>שולחים מסמך לחתימה מכרטיס הרשומה, בכרטיס &quot;מסמכים לחתימה&quot;: הלקוח מקבל קישור, קורא וחותם מהטלפון, וה-PDF החתום נשמר ברשומה.</p>
          <p>נוסח לפי מגדר: כותבים בסוגריים נוסח לזכר, לנקבה ונוסח ניטרלי, והמערכת בוחרת לפי המגדר ברשומה. הנוסח הניטרלי חובה.</p>
          <p className="rounded-md bg-canvas px-3 py-2 text-sm text-ink">{VARIANT_EXAMPLE}</p>
          {/* owner, 8 October 2026: legal texts are drafts until the lawyer edits them */}
          <p className="rounded-md bg-canvas px-3 py-2 text-sm text-ink">טיוטה: הנוסחים של תבניות ברירת המחדל עוד לא אושרו על ידי עורך דין.</p>
          {inPlan ? null : (
            <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
              תבניות מסמך אינן כלולות בחבילה של העסק. אפשר לקרוא את התבניות{manageable ? ", לכבות אותן ולמחוק אותן" : ""}, ובחבילה &quot;בסיס&quot; ומעלה גם להפעיל, לערוך ולהוסיף.
            </p>
          )}
        </CardBody>
        {templates.length > 0 ? (
          <div className="mt-3 border-t border-line">
            <DocumentTemplateList orgId={orgId} templates={templates} editable={editable} removable={removable} labels={labels} />
          </div>
        ) : (
          <EmptyState
            compact
            icon={<FormIcon />}
            title="עוד אין תבניות מסמך"
            description={editable ? "מוסיפים תבנית ראשונה בטופס שלמטה." : "בעלים ומנהלי מערכת מוסיפים תבניות."}
            className="mt-3 border-t border-line"
          />
        )}
        {editable && templates.length < DOCUMENT_TEMPLATES_PER_ORG ? (
          <CardBody className="border-t border-line">
            <AddDocumentTemplateForm orgId={orgId} labels={labels} />
          </CardBody>
        ) : null}
      </Card>
      {templates.length > 0 ? (
        <Card aria-label="תצוגה מקדימה">
          <CardBody>
            <DocumentTemplatePreview orgId={orgId} templates={templates} business={business} labels={labels} />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
