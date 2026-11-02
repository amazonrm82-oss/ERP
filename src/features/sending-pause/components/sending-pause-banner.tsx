import Link from "next/link";

import { formatDateTime } from "@/lib/format";

import { sendingPauseSettingsPath } from "../paths";
import { pauseBannerText } from "../pause";
import { getSendingPauseQuiet } from "../queries";

/**
 * HEB-09: the line under the business header while automatic sending to customers is paused, for every member.
 * Self-contained (reads its own row, a failed read shows nothing), so the layout only places it.
 */
export async function SendingPauseBanner({ orgId, admin }: { orgId: string; admin: boolean }) {
  const pause = await getSendingPauseQuiet(orgId);
  const text = pauseBannerText(pause, pause.pausedAt ? formatDateTime(pause.pausedAt) : null);
  if (!text) return null;
  return (
    <p role="status" className="border-b border-line bg-warning-soft px-4 py-2.5 text-sm break-words text-warning sm:px-6">
      {text}{" "}
      {admin ? (
        <Link href={sendingPauseSettingsPath(orgId)} className="font-medium underline underline-offset-4">
          לחידוש השליחה
        </Link>
      ) : null}
    </p>
  );
}
