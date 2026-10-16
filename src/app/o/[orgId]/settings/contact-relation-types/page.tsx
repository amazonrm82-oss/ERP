import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { AddRelationTypeForm, RelationTypeList } from "@/features/contact-relations/components/types-editor";
import { listRelationTypes } from "@/features/contact-relations/queries";
import { CONTACT_RELATION_TYPES_PER_ORG } from "@/features/contact-relations/types";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "קשרים בין אנשי קשר" };

type Props = { params: Promise<{ orgId: string }> };

/** CON-06: the types of relation between contacts. Owners and admins edit the list. */
export default async function ContactRelationTypesPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const types = await listRelationTypes(orgId);

  return (
    <Card aria-labelledby="contact-relation-types-title">
      <CardHeader id="contact-relation-types-title" title="קשרים בין אנשי קשר" />
      <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
        <p>
          בכרטיס של איש קשר רושמים את הקשר שלו לאיש קשר אחר. כל סוג נקרא מהצד הראשון (למשל &quot;הורה של&quot;) ומהצד השני (&quot;ילד/ה של&quot;). כשהקשר
          זהה משני הצדדים, משאירים את השדה השני ריק. אפשר לשמור עד {CONTACT_RELATION_TYPES_PER_ORG} סוגים.
        </p>
        <p>שינוי שם מתעדכן אצל כל אנשי הקשר. סוג מוסתר נשאר אצל מי שכבר נרשם בו. אפשר למחוק רק סוג שלא רשום אצל אף איש קשר.</p>
      </CardBody>
      {types.length > 0 ? (
        <div className="mt-3 border-t border-line">
          <RelationTypeList orgId={orgId} types={types} editable={editable} />
        </div>
      ) : (
        <CardBody className="mt-3 border-t border-line">
          <p className="text-md text-ink-soft">אין סוגי קשר ברשימה. כל עוד היא ריקה, אי אפשר לרשום קשרים בין אנשי קשר.</p>
        </CardBody>
      )}
      {editable && types.length < CONTACT_RELATION_TYPES_PER_ORG ? (
        <CardBody className="border-t border-line">
          <AddRelationTypeForm orgId={orgId} />
        </CardBody>
      ) : null}
    </Card>
  );
}
