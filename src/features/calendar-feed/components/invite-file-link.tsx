import { buttonClasses } from "@/components/ui/button";
import { CalendarIcon } from "@/components/ui/icons";

import { meetingInvitePath } from "../paths";

/**
 * CAL-07: downloads the meeting as an .ics file to send to the customer. A plain
 * link (works in the record pages, a server component, and in the calendar window).
 */
export function InviteFileLink({ orgId, meetingId, title }: { orgId: string; meetingId: string; title: string }) {
  return (
    <a href={meetingInvitePath(orgId, meetingId)} download className={buttonClasses("ghost", "sm")}>
      <CalendarIcon className="size-4" />
      הורדת קובץ הזמנה (ics)
      <span className="sr-only">: {title}</span>
    </a>
  );
}
