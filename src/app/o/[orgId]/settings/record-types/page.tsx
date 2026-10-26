import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { BuildingIcon, UsersIcon } from "@/components/ui/icons";
import { AddTypeForm, TypeList } from "@/features/record-type-options/components/types-editor";
import { listRecordTypes } from "@/features/record-type-options/queries";
import { TYPE_TEXTS, TYPES_PER_OBJECT, type RecordType, type RecordTypeObject } from "@/features/record-type-options/schema";
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
        <EmptyState
          compact
          icon={object === "contact" ? <UsersIcon /> : <BuildingIcon />}
          title="עוד אין סוגים"
          description={editable ? "כל עוד הרשימה ריקה, הטפסים לא מציגים את השדה. מוסיפים סוג ראשון בטופס שלמטה." : "כל עוד הרשימה ריקה, הטפסים לא מציגים את השדה."}
          className="mt-3 border-t border-line"
        />
      )}
      {editable && types.length < TYPES_PER_OBJECT ? (
        <CardBody className="border-t border-line">
          <AddTypeForm orgId={orgId} object={object} />
        </CardBody>
      ) : null}
    </Card>
  );
}
