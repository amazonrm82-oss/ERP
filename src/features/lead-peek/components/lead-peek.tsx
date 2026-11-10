import { timelineEntryId } from "@/features/activities/schema";
import { nextWorkingDay } from "@/features/calendar-days/business-days";
import { getCalendarSettings } from "@/features/calendar-days/queries";
import { activeReasonNames } from "@/features/disqualify-reasons/queries";
import { inlineEditing } from "@/features/inline-edit/server";
import { statusTone } from "@/features/leads/display";
import { canEditRecordHint, type OrgContext } from "@/features/shell/queries";
import { recordTemplateValues } from "@/features/whatsapp/templates";
import { addDays } from "@/lib/calendar-grid";
import { formatDateTime, telUrl, whatsappUrl, zoneDate, zoneTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { waitingText } from "@/lib/waiting-time";

import { callBackPick, peekHref, peekNeighbours, peekRights, showCreatedAgo, timelineItemHref, type PeekLinks } from "../model";
import { getPeekLead } from "../queries";
import { queueLinks, queuePositionText } from "../queue";
import { LeadPeekPanel } from "./lead-peek-panel";

type Props = {
  orgId: string;
  context: OrgContext;
  links: PeekLinks;
  // the leads of the list as shown, for ↑ / ↓
  listIds: string[];
  listPath: string;
  // UX-02: the waiting list's "מצב תור": after an action in the panel, the next lead of `listIds` opens in it
  queue?: boolean;
};

/** UX-01: reads the lead the address names (?peek=) with the user's session and shows the side panel. A lead that cannot be read shows nothing. */
export async function LeadPeek({ orgId, context, links, listIds, listPath, queue = false }: Props) {
  const leadId = links.peekId;
  if (!leadId) return null;
  const lead = await getPeekLead(orgId, leadId);
  if (!lead) return null;
  const rights = peekRights({
    offeredOnly: lead.offeredOnly,
    canWrite: context.canWrite,
    canEditRecord: canEditRecordHint(context, lead.ownerId),
    ownerId: lead.ownerId,
    statusKind: lead.status?.kind,
    converted: lead.converted,
  });
  const [reasons, editing, calendar] = await Promise.all([
    rights.canEdit ? activeReasonNames(orgId) : Promise.resolve([]),
    rights.mode === "work" ? inlineEditing(orgId, context) : Promise.resolve(null),
    rights.canLog ? getCalendarSettings(orgId) : Promise.resolve(null),
  ]);
  const { previous, next } = peekNeighbours(listIds, lead.id);
  // read once per request on the server; the clocks run on in the browser
  const now = new Date();
  const zone = context.org.timeZone;
  const today = zoneDate(now, zone);
  const nowTime = zoneTime(now, zone);
  const pick = (shortcut: "hour" | "tomorrow" | "week") =>
    callBackPick(shortcut, today, nowTime, (day) => (calendar ? nextWorkingDay(calendar, day) : day), addDays);
  const age = now.getTime() - Date.parse(lead.createdAt);
  const inQueue = queue ? queueLinks(listPath, links.params, listIds, lead.id) : null;

  return (
    <LeadPeekPanel
      orgId={orgId}
      rights={rights}
      reasons={reasons}
      owners={editing && editing.canReassign(lead.ownerId) ? editing.owners : null}
      closeHref={links.closeHref}
      fullHref={paths.lead(orgId, lead.id)}
      previousHref={previous ? peekHref(listPath, links.params, previous) : null}
      nextHref={next ? peekHref(listPath, links.params, next) : null}
      queue={inQueue ? { afterHref: inQueue.afterHref, label: queuePositionText(inQueue.position) } : null}
      callBack={rights.canLog ? { hour: pick("hour"), tomorrow: pick("tomorrow"), week: pick("week") } : null}
      whatsappValues={recordTemplateValues({ fullName: lead.fullName, gender: lead.gender }, context)}
      lead={{
        id: lead.id,
        name: lead.name,
        phone: lead.phone,
        phoneE164: lead.phoneE164,
        tel: telUrl(lead.phoneE164, lead.phone),
        whatsapp: whatsappUrl(lead.phoneE164),
        email: lead.email,
        status: lead.status ? { id: lead.status.id, name: lead.status.name, tone: statusTone(lead.status) } : null,
        statuses: lead.statuses.filter((option) => option.kind !== "converted"),
        disqualifiedStatusId: lead.statuses.find((option) => option.kind === "disqualified")?.id ?? null,
        ownerId: lead.ownerId,
        ownerName: lead.ownerName,
        sourceName: lead.sourceName,
        createdAt: lead.createdAt,
        createdAgo: showCreatedAgo(lead.waiting) ? waitingText(age) : null,
        waiting: lead.waiting,
        waitingInitial: waitingText(age),
        asked: lead.asked,
        timeline: lead.timeline.map((item) => ({
          id: item.id,
          label: item.label,
          text: item.text,
          when: formatDateTime(item.occurredAt),
          author: item.authorName,
          isPrivate: item.isPrivate,
          href: timelineItemHref(orgId, lead.id, timelineEntryId(item.id)),
        })),
      }}
    />
  );
}
