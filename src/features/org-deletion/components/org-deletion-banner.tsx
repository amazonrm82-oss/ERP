import Link from "next/link";

import { orgDeletionPath } from "../paths";
import { getOrgDeletionStatus } from "../queries";
import { deletionBannerText, deletionDayText } from "../texts";

/**
 * ADM-03: the line under the business header while the business waits to be deleted, for every member. Self-contained (a
 * failed read shows nothing); the owner gets the way to cancel.
 */
export async function OrgDeletionBanner({ orgId, owner, timeZone }: { orgId: string; owner: boolean; timeZone: string }) {
  const status = await getOrgDeletionStatus(orgId);
  const text = deletionBannerText(status, deletionDayText(status.scheduledFor, timeZone) || null, owner);
  if (!text) return null;
  return (
    <p role="status" className="border-b border-danger bg-danger-soft px-4 py-2.5 text-sm font-medium break-words text-danger-strong sm:px-6">
      {text}{" "}
      {owner ? (
        <Link href={orgDeletionPath(orgId)} className="underline underline-offset-4">
          ביטול המחיקה
        </Link>
      ) : null}
    </p>
  );
}
