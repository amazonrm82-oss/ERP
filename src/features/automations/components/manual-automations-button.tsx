import type { ManualEntity } from "../manual";
import { listManualAutomations } from "../manual-queries";

import { ManualAutomations } from "./manual-automations";

/** AUT-03: the card's manual rules for this record, read with the user's session; nothing when there are none. */
export async function ManualAutomationsButton({ orgId, entity, recordId }: { orgId: string; entity: ManualEntity; recordId: string }) {
  const rules = await listManualAutomations(orgId, entity, recordId);
  if (rules.length === 0) return null;
  return <ManualAutomations orgId={orgId} entity={entity} recordId={recordId} rules={rules} />;
}
