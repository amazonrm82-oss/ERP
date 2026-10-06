import "server-only";

import type { OrgContext } from "@/features/shell/queries";

import type { ViewChip } from "./components/saved-views-bar";
import { listSavedViews } from "./queries";
import type { ViewObject } from "./types";

/** Saved views of a list as chips, with who may delete which. */
export async function viewChips(orgId: string, objectType: ViewObject, context: OrgContext): Promise<ViewChip[]> {
  const isAdmin = context.role === "owner" || context.role === "admin";
  const views = await listSavedViews(orgId, objectType);
  return views.map((view) => ({
    id: view.id,
    name: view.name,
    shared: view.scope !== "private",
    deletable: view.ownerId === context.user.id || isAdmin,
    filters: view.filters,
  }));
}
