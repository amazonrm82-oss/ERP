import "server-only";

import { cache } from "react";

import { getOrgModules } from "@/features/modules/queries";
import { orgHasFeature } from "@/features/settings/queries";

/**
 * ORD-01 (owner, 19 October 2026): orders show while the plan has the `orders` key AND the business switched the module
 * on (off by default). Off only hides screens and actions; the database still refuses a new order without the plan key.
 */
export const getOrdersAccess = cache(async (orgId: string): Promise<{ inPlan: boolean; on: boolean; offerClosed: boolean }> => {
  const [inPlan, modules] = await Promise.all([orgHasFeature(orgId, "orders"), getOrgModules(orgId)]);
  return { inPlan, on: inPlan && modules.orders, offerClosed: modules.ordersOfferClosed };
});
