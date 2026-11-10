import type { HelpScreen } from "@/features/help/content";
import { getOrgTerms } from "@/features/terminology/queries";

import { screenHelp } from "../guide";
import { ScreenMoreMenuPopover, type MoreMenuLink } from "./screen-more-menu-popover";

/** A main screen's "…" menu for the phone: its secondary links and its "?" help, in the business's own words (FLD-10). */
export async function ScreenMoreMenu({ orgId, screen, links }: { orgId: string; screen: HelpScreen; links: MoreMenuLink[] }) {
  const terms = await getOrgTerms(orgId);
  return <ScreenMoreMenuPopover orgId={orgId} help={screenHelp(screen, terms)} links={links} />;
}
