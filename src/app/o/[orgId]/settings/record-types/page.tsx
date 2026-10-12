import type { Metadata } from "next";

import { ActionButton } from "@/components/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { addSuggestedTypesAction } from "@/features/record-type-options/actions";
import { AddTypeForm, TypeList } from "@/features/record-type-options/components/types-editor";
import { listRecordTypes } from "@/features/record-type-options/queries";
import { SUGGESTED_TYPES, TYPE_TEXTS, TYPES_PER_OBJECT, type RecordType, type RecordTypeObject } from "@/features/record-type-options/schema";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "סוגי אנשי קשר וחברות" };

type Props = { params: Promise<{ orgId: string }> };

/** CON-02: the lists a contact's type and a company's type are picked from. Owners and admins edit them. */
export default async function RecordTypesPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const [contactTypes, companyTypes] = await Promise.all([listRecordTypes(orgId, "contact"), listRecordTypes(orgId, "company")]);

  return (
    <div className="space-y-6">
      <TypesCard orgId={orgId} object="contact" types={contactTypes} editable={editable} />
      <TypesCard orgId={orgId} object="company" types={companyTypes} editable={editable} />
    </div>
  );
}

function TypesCard({ orgId, object, types, editable }: { orgId: string; object: RecordTypeObject; types: RecordType[]; editable: boolean }) {
  const texts = TYPE_TEXTS[object];
  const titleId = `${object}-types-title`;
  return (
    <Card aria-labelledby={titleId}>
      <CardHeader id={titleId} title={texts.title} />
      <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
        <p>
          {object === "contact" ? "לכל איש קשר" : "לכל חברה"} אפשר לבחור סוג מהרשימה הזו, ואחר כך לסנן את הרשימה לפיו. שינוי שם של סוג משנה אותו בכל
          הרשומות. סוג מוסתר נשאר ברשומות שכבר יש להן אותו.
        </p>
      </CardBody>
      {types.length > 0 ? (
        <div className="mt-3 border-t border-line">
          <TypeList orgId={orgId} object={object} types={types} editable={editable} />
        </div>
      ) : (
        <CardBody className="mt-3 space-y-3 border-t border-line">
          <p className="text-md text-ink-soft">עוד אין סוגים ברשימה. עד שתוסיפו, הטפסים לא מציגים את השדה.</p>
          {editable ? (
            <div className="space-y-2">
              <p className="text-sm text-ink-soft">אפשר להתחיל מהסוגים המוצעים: {SUGGESTED_TYPES.join(", ")}.</p>
              <ActionButton action={addSuggestedTypesAction.bind(null, orgId, object)} pendingText="מוסיפים…" srLabel={texts.title}>
                הוספת הסוגים המוצעים
              </ActionButton>
            </div>
          ) : null}
        </CardBody>
      )}
      {editable && types.length < TYPES_PER_OBJECT ? (
        <CardBody className="border-t border-line">
          <AddTypeForm orgId={orgId} object={object} />
        </CardBody>
      ) : null}
    </Card>
  );
}
