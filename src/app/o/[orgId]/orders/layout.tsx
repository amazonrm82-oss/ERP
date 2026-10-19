import type { ReactNode } from "react";

import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ModuleOff } from "@/features/modules/components/module-off";
import { getOrdersAccess } from "@/features/orders/access";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

type Props = { children: ReactNode; params: Promise<{ orgId: string }> };

// ORD-01: the orders pages show only while the plan holds orders and the business switched the module on. A layout hides;
// it does not guard: RLS and the plan check in the database decide every read and write.
export default async function OrdersLayout({ children, params }: Props) {
  const { orgId } = await params;
  const access = await getOrdersAccess(orgId);
  if (access.on) return children;
  const context = await getOrgContext(orgId);
  return (
    <>
      <PageHeader title="הזמנות" />
      {access.inPlan ? (
        <ModuleOff orgId={orgId} title="מודול ההזמנות" canChange={isAdminRole(context.role) && context.canWrite} />
      ) : (
        <Card>
          <CardBody>
            <p>מודול ההזמנות לא כלול בחבילה של העסק.</p>
          </CardBody>
        </Card>
      )}
    </>
  );
}
