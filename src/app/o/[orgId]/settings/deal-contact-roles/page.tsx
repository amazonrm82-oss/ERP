import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { UsersIcon } from "@/components/ui/icons";
import { AddDealContactRoleForm, DealContactRoleList } from "@/features/deal-contacts/components/roles-editor";
import { listDealContactRoles } from "@/features/deal-contacts/queries";
import { DEAL_CONTACT_ROLES_PER_ORG } from "@/features/deal-contacts/roles";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "תפקידים בעסקה" };

type Props = { params: Promise<{ orgId: string }> };

/** CON-03 follow-up: the roles a contact may have on a deal. Owners and admins edit the list. */
export default async function DealContactRolesPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const roles = await listDealContactRoles(orgId);

  return (
    <Card aria-labelledby="deal-contact-roles-title">
      <CardHeader id="deal-contact-roles-title" title="תפקידים בעסקה" />
      <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
        <p>כשמוסיפים איש קשר לעסקה, בוחרים את התפקיד שלו מהרשימה הזו. אפשר לשמור עד {DEAL_CONTACT_ROLES_PER_ORG} תפקידים.</p>
        <p>שינוי שם מתעדכן בכל העסקאות. תפקיד מוסתר נשאר אצל מי שכבר סומן בו. מחיקה משאירה את איש הקשר בעסקה, בלי תפקיד.</p>
      </CardBody>
      {roles.length > 0 ? (
        <div className="mt-3 border-t border-line">
          <DealContactRoleList orgId={orgId} roles={roles} editable={editable} />
        </div>
      ) : (
        <EmptyState
          compact
          icon={<UsersIcon />}
          title="עוד אין תפקידים"
          description={editable ? "כל עוד הרשימה ריקה, מוסיפים אנשי קשר לעסקה בלי תפקיד. מוסיפים תפקיד ראשון בטופס שלמטה." : "כל עוד הרשימה ריקה, מוסיפים אנשי קשר לעסקה בלי תפקיד."}
          className="mt-3 border-t border-line"
        />
      )}
      {editable && roles.length < DEAL_CONTACT_ROLES_PER_ORG ? (
        <CardBody className="border-t border-line">
          <AddDealContactRoleForm orgId={orgId} />
        </CardBody>
      ) : null}
    </Card>
  );
}
