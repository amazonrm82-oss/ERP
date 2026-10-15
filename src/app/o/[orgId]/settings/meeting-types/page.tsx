import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { AddMeetingTypeButton, MeetingTypeList } from "@/features/meeting-types/components/types-editor";
import { listMeetingTypes } from "@/features/meeting-types/queries";
import { MEETING_TYPES_PER_ORG } from "@/features/meeting-types/schema";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "סוגי פגישה" };

type Props = { params: Promise<{ orgId: string }> };

/** CAL-08: the kinds of meeting the business holds. Everyone reads the list; owners and admins edit it. */
export default async function MeetingTypesPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  // the linked service comes from the catalogue: only while the plan holds products
  const [types, products] = await Promise.all([listMeetingTypes(orgId), orgHasFeature(orgId, "products")]);

  return (
    <Card aria-labelledby="meeting-types-title">
      <CardHeader id="meeting-types-title" title="סוגי פגישה" />
      <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
        <p>כשקובעים פגישה ובוחרים סוג, המשך, אופן הפגישה והמיקום נכנסים לבד, ואפשר לשנות אותם. הצבע מסמן את הפגישה ביומן.</p>
        <p>שינוי בסוג לא משנה פגישות שכבר נקבעו, חוץ מהצבע ומהמרווח, שנלקחים תמיד מהסוג.</p>
      </CardBody>
      {types.length > 0 ? (
        <div className="mt-3 border-t border-line">
          <MeetingTypeList orgId={orgId} types={types} editable={editable} products={products} />
        </div>
      ) : (
        <CardBody className="mt-3 border-t border-line">
          <p className="text-md text-ink-soft">אין סוגי פגישה. אפשר לקבוע פגישות גם בלי סוג.</p>
        </CardBody>
      )}
      {editable && types.length < MEETING_TYPES_PER_ORG ? (
        <CardBody className="border-t border-line">
          <AddMeetingTypeButton orgId={orgId} products={products} />
        </CardBody>
      ) : null}
    </Card>
  );
}
