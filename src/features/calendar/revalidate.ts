import "server-only";

import { revalidatePath } from "next/cache";

import { recordPage } from "@/lib/record-types";

import { calendarPath } from "./range";

/** The records a meeting or a task is linked to. */
export type LinkedRecords = { lead_id: string | null; contact_id: string | null; company_id: string | null; deal_id: string | null };

/** After a meeting or task changed: the calendar and the page of every record it is linked to. */
export function revalidateLinked(orgId: string, row: LinkedRecords) {
  revalidatePath(calendarPath(orgId));
  if (row.lead_id) revalidatePath(recordPage("lead", orgId, row.lead_id));
  if (row.contact_id) revalidatePath(recordPage("contact", orgId, row.contact_id));
  if (row.company_id) revalidatePath(recordPage("company", orgId, row.company_id));
  if (row.deal_id) revalidatePath(recordPage("deal", orgId, row.deal_id));
}
