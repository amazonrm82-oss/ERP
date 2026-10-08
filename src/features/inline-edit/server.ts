import "server-only";

import { canExport } from "@/features/reports/request";
import { listMembers } from "@/features/settings/queries";
import { canEditRecordHint, type OrgContext } from "@/features/shell/queries";

import type { InlineOption } from "./components/inline-edit";

// What a list table needs to offer editing in its cells (LST-06).
export type InlineEditing = {
  orgId: string;
  // who a record can be handed to: active members who can write
  owners: InlineOption[];
  // a hint only; the database has the last word
  canEdit: (ownerId: string | null) => boolean;
  // handing a record to someone else: a member may only edit what they own, so only managers and up
  canReassign: (ownerId: string | null) => boolean;
  // bulk actions on picked rows (LST-07): for anyone who writes; handing over and the recycle bin as above
  bulk: { reassign: boolean; trash: boolean; exportable: boolean } | null;
};

export async function inlineEditing(orgId: string, context: OrgContext): Promise<InlineEditing> {
  const members = context.canWrite ? await listMembers(orgId) : [];
  return {
    orgId,
    owners: members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ value: m.userId, label: m.name })),
    canEdit: (ownerId) => canEditRecordHint(context, ownerId),
    canReassign: (ownerId) => context.role !== "member" && canEditRecordHint(context, ownerId),
    bulk: context.canWrite ? { reassign: context.role !== "member", trash: context.role !== "member", exportable: canExport(context.role) } : null,
  };
}
