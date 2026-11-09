import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { CalendarIcon } from "@/components/ui/icons";
import { MeetingOrderDraftModeForm } from "@/features/meeting-order-draft/components/mode-form";
import { getMeetingOrderDraftMode } from "@/features/meeting-order-draft/queries";
import { MEETING_ORDER_DRAFT_OPTIONS } from "@/features/meeting-order-draft/rules";
import { AddMeetingTypeButton, MeetingTypeList } from "@/features/meeting-types/components/types-editor";
import { listMeetingTypes } from "@/features/meeting-types/queries";
import { MEETING_TYPES_PER_ORG } from "@/features/meeting-types/schema";
import { getOrdersAccess } from "@/features/orders/access";
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
  const [types, products, orders] = await Promise.all([listMeetingTypes(orgId), orgHasFeature(orgId, "products"), getOrdersAccess(orgId)]);
  // CAL-13: a held meeting's draft order, while the plan holds orders and products
  const draftMode = products && orders.inPlan ? await getMeetingOrderDraftMode(orgId) : null;

  return (
    <div className="space-y-5">
      <Card aria-labelledby="meeting-types-title">
        <CardHeader id="meeting-types-title" title="סוגי פגישה" />
        <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
          <p>כשקובעים פגישה ובוחרים סוג, המשך, אופן הפגישה והמיקום נכנסים לבד, ואפשר לשנות אותם. הצבע מסמן את הפגישה ביומן.</p>
          <p>שינוי בסוג לא משנה פגישות שכבר נקבעו, חוץ מהצבע, שנלקח תמיד מהסוג. המרווח לפני ואחרי מועתק לפגישה כשהיא נקבעת.</p>
        </CardBody>
        {types.length > 0 ? (
          <div className="mt-3 border-t border-line">
            <MeetingTypeList orgId={orgId} types={types} editable={editable} products={products} />
          </div>
        ) : (
          <EmptyState
            compact
            icon={<CalendarIcon />}
            title="עוד אין סוגי פגישה"
            description={editable ? "סוג ממלא לבד משך, מיקום וצבע. אפשר לקבוע פגישות גם בלי סוג." : "אפשר לקבוע פגישות גם בלי סוג."}
            action={editable ? <AddMeetingTypeButton orgId={orgId} products={products} /> : null}
            className="mt-3 border-t border-line"
          />
        )}
        {editable && types.length > 0 && types.length < MEETING_TYPES_PER_ORG ? (
          <CardBody className="border-t border-line">
            <AddMeetingTypeButton orgId={orgId} products={products} />
          </CardBody>
        ) : null}
      </Card>
      {draftMode ? (
        <Card aria-labelledby="meeting-order-draft-title">
          <CardHeader id="meeting-order-draft-title" title="הזמנה מפגישה" />
          <CardBody className="space-y-3">
            {orders.on ? null : <p className="text-sm text-ink-soft">ההזמנות כבויות בעסק, ולכן לא נוצרות טיוטות עד שמפעילים אותן.</p>}
            {editable ? (
              <MeetingOrderDraftModeForm orgId={orgId} mode={draftMode} />
            ) : (
              <p className="text-sm">
                טיוטת הזמנה מפגישה שהתקיימה נוצרת:{" "}
                <span className="font-medium">{MEETING_ORDER_DRAFT_OPTIONS.find((option) => option.value === draftMode)!.label}</span>
              </p>
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
