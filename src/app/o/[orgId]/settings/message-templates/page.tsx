import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { ChatIcon } from "@/components/ui/icons";
import { AddMessageTemplateForm, MessageTemplateList } from "@/features/message-templates/components/templates-editor";
import { TemplatePreview } from "@/features/message-templates/components/template-preview";
import { MESSAGE_MERGE_FIELDS } from "@/features/message-templates/fields";
import { listMessageTemplates } from "@/features/message-templates/queries";
import { SERVICE_BODY_MAX } from "@/features/message-templates/service-rule";
import { MESSAGE_TEMPLATES_PER_ORG, MESSAGE_TYPE_LABELS } from "@/features/message-templates/templates";
import { SERVICE_MESSAGE_TYPES } from "@/features/messaging/providers/types";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { getDocumentDetails } from "@/features/tax/queries";
import { businessAddressLine } from "@/features/message-templates/envelope";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";
import { VARIANT_EXAMPLE } from "@/features/whatsapp/variants";

export const metadata: Metadata = { title: "תבניות הודעה" };

type Props = { params: Promise<{ orgId: string }> };

/** MSG-02: the shared message templates (email, SMS, WhatsApp). Owners and admins edit them; every member reads them. */
export default async function MessageTemplatesPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const editable = isAdminRole(context.role) && context.canWrite;
  const supabase = await createClient();
  const [templates, details, org] = await Promise.all([
    listMessageTemplates(orgId),
    getDocumentDetails(orgId),
    supabase.from("organizations").select("phone").eq("id", orgId).maybeSingle(),
  ]);
  const orgPhone = must(org, "organization phone")?.phone ?? null;
  const businessPhone = details.phone?.trim() || orgPhone?.trim() || null;

  return (
    <div className="space-y-4">
      <Card aria-labelledby="message-templates-title">
        <CardHeader id="message-templates-title" title="תבניות הודעה" />
        <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
          <p>נוסחים מוכנים להודעות ללקוחות באימייל, ב-SMS וב-WhatsApp, משותפים לכל העסק. כרגע המערכת עוד לא שולחת אותם בעצמה.</p>
          <p>
            לכל תבנית יש סוג. הודעות שירות הן רק {SERVICE_MESSAGE_TYPES.map((type) => MESSAGE_TYPE_LABELS[type]).join(", ")}. הן נשלחות גם למי שביקש
            להפסיק לקבל דיוור, אבל אף פעם לא לכתובת שברשימת החסימה ולא למי שפרטיו נמחקו. כל סוג אחר הוא הודעה שיווקית, והיא נשלחת רק למי שהסכים לקבל
            הודעות בערוץ הזה.
          </p>
          <p>
            בתבנית של הודעת שירות אפשר להשתמש רק בשדות שמתאימים לסוג שלה, אי אפשר לכתוב בה קישור (המערכת מוסיפה את הקישורים שלה דרך השדות), והאורך
            מוגבל: עד {SERVICE_BODY_MAX.sms} תווים ב-SMS, עד {SERVICE_BODY_MAX.whatsapp.toLocaleString("he-IL")} ב-WhatsApp ועד{" "}
            {SERVICE_BODY_MAX.email.toLocaleString("he-IL")} באימייל. תבנית כזאת נשמרת גם כשהיא לא עומדת בכללים, אבל לא תישלח, וליד התבנית כתוב למה.
          </p>
          <p>בנוסח ובנושא אפשר לכתוב את השדות האלה, והם יוחלפו לבד:</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {Object.values(MESSAGE_MERGE_FIELDS).map((field) => (
              <div key={field.token} className="contents">
                <dt className="font-medium text-ink">{field.token}</dt>
                <dd>{field.label}</dd>
              </div>
            ))}
          </dl>
          <p>נוסח לפי מגדר: כותבים בסוגריים נוסח לזכר, לנקבה ונוסח ניטרלי, והמערכת בוחרת לפי המגדר ברשומה. הנוסח הניטרלי חובה.</p>
          <p className="rounded-md bg-canvas px-3 py-2 text-sm text-ink">{VARIANT_EXAMPLE}</p>
          <p className="text-sm">ב-SMS הודעה בעברית עד 70 תווים נשלחת כהודעה אחת. הודעה ארוכה יותר נשלחת בכמה חלקים מחוברים.</p>
          <p>
            בהודעה שיווקית המערכת מוסיפה לבד את המילה ״פרסומת״ בתחילת הנושא (ב-SMS וב-WhatsApp בתחילת ההודעה), שורה עם שם העסק, הטלפון והכתובת, ושורת
            הסרה מרשימת התפוצה. אי אפשר להוריד אותם מהתבנית.
          </p>
          {/* owner (88): the default wordings are a draft until the lawyer approves them */}
          <p className="rounded-md bg-canvas px-3 py-2 text-sm text-ink">טיוטה: הנוסחים של תבניות ברירת המחדל עוד לא אושרו על ידי עורך דין.</p>
        </CardBody>
        {templates.length > 0 ? (
          <div className="mt-3 border-t border-line">
            <MessageTemplateList orgId={orgId} templates={templates} editable={editable} />
          </div>
        ) : (
          <EmptyState
            compact
            icon={<ChatIcon />}
            title="עוד אין תבניות הודעה"
            description={editable ? "מוסיפים תבנית ראשונה בטופס שלמטה." : "בעלים ומנהלי מערכת מוסיפים תבניות."}
            className="mt-3 border-t border-line"
          />
        )}
        {editable && templates.length < MESSAGE_TEMPLATES_PER_ORG ? (
          <CardBody className="border-t border-line">
            <AddMessageTemplateForm orgId={orgId} />
          </CardBody>
        ) : null}
      </Card>
      {templates.length > 0 ? (
        <Card aria-label="תצוגה מקדימה">
          <CardBody>
            <TemplatePreview
              orgId={orgId}
              templates={templates}
              userName={context.user.displayName}
              businessName={context.org.name}
              businessPhone={businessPhone}
              businessAddress={businessAddressLine(details)}
            />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
