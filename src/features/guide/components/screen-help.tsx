import type { HelpScreen } from "@/features/help/content";
import { getOrgTerms } from "@/features/terminology/queries";

import { screenHelp } from "../guide";
import { ScreenHelpPopover } from "./screen-help-popover";

/** UX-05 (ב): the "?" button of a main screen, in the business's own words (FLD-10). Put it in the PageHeader's actions. */
export async function ScreenHelp({ orgId, screen }: { orgId: string; screen: HelpScreen }) {
  const terms = await getOrgTerms(orgId);
  return <ScreenHelpPopover orgId={orgId} help={screenHelp(screen, terms)} />;
}
