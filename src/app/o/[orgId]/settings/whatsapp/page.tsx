import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { AddTemplateForm, TemplateList } from "@/features/whatsapp/components/templates-editor";
import { listWhatsappTemplates } from "@/features/whatsapp/queries";
import { PLACEHOLDERS, TEMPLATES_PER_ORG } from "@/features/whatsapp/templates";

export const metadata: Metadata = { title: "תבניות WhatsApp" };

type Props = { params: Promise<{ orgId: string }> };

/** WA-01: the texts the WhatsApp button of a record offers. Owners and admins edit them. */
export default async function WhatsappTemplatesPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const templates = await listWhatsappTemplates(orgId);

  return (
    <Card aria-labelledby="whatsapp-templates-title">
      <CardHeader id="whatsapp-templates-title" title="תבניות WhatsApp" />
      <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
        <p>
          כשלוחצים על WhatsApp בכרטיס של ליד, איש קשר או חברה, אפשר לבחור תבנית. ההודעה נפתחת ב-WhatsApp כתובה מראש, הנציג שולח אותה בעצמו,
          והיא נרשמת בציר הזמן.
        </p>
        <p>בנוסח אפשר לכתוב את החלקים האלה, והם יוחלפו לבד:</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {Object.values(PLACEHOLDERS).map((placeholder) => (
            <div key={placeholder.token} className="contents">
              <dt className="font-medium text-ink">{placeholder.token}</dt>
              <dd>{placeholder.label}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm">תאריך ושעה מתמלאים רק בתזכורת לפגישה. בכרטיס רשומה הנציג משלים אותם לפני השליחה.</p>
      </CardBody>
      {templates.length > 0 ? (
        <div className="mt-3 border-t border-line">
          <TemplateList orgId={orgId} templates={templates} editable={editable} />
        </div>
      ) : (
        <CardBody className="mt-3 border-t border-line">
          <p className="text-md text-ink-soft">אין תבניות. כפתור ה-WhatsApp יפתח הודעה ריקה.</p>
        </CardBody>
      )}
      {editable && templates.length < TEMPLATES_PER_ORG ? (
        <CardBody className="border-t border-line">
          <AddTemplateForm orgId={orgId} />
        </CardBody>
      ) : null}
    </Card>
  );
}
