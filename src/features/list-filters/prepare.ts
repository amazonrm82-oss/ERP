import "server-only";

import type { FieldDefinition } from "@/features/custom-fields/types";
import { getLeadLookups } from "@/features/leads/queries";
import { listRecordTypes } from "@/features/record-type-options/queries";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { listTags } from "@/features/tags/queries";

import { parseFilterParam } from "./model";
import { appliedFilter, filterFields, filterToPostgrest, publicFields, type FilterObject, type PreparedFilter } from "./server";

// The choices the filter offers. Every reader here is memoized per request (FXC-09), so a page that starts them
// early with startListFilterLookups() and then calls prepareListFilter() reads each one once.
function filterLookups(orgId: string, object: FilterObject) {
  return Promise.all([
    object === "lead" || object === "contact" ? getLeadLookups(orgId) : null,
    listMembers(orgId),
    object === "task" ? [] : listTags(orgId),
    object === "contact" || object === "company" ? listRecordTypes(orgId, object) : [],
  ]);
}

/**
 * Starts reading the filter's choices, so a list page can run them next to its columns (FXC-09) instead of after
 * them. Resolves to nothing; prepareListFilter() then gets the same reads from the request's memo.
 */
export async function startListFilterLookups(orgId: string, object: FilterObject): Promise<void> {
  await filterLookups(orgId, object);
}

/**
 * The advanced filter of a list page (LST-05): the fields it offers (with the
 * organization's statuses, sources, users and tags as choices), and the filter
 * from the URL turned into a query, checked against those fields.
 */
export async function prepareListFilter(
  orgId: string,
  object: FilterObject,
  param: string,
  userId: string,
  customFields: FieldDefinition[],
  // the deals table: the stages of the pipeline on screen
  extra: { stages?: Array<{ id: string; name: string }> } = {},
): Promise<PreparedFilter> {
  // memoized per request: the page has already read the context, and started the rest (startListFilterLookups)
  const [context, [lookups, members, tags, types]] = await Promise.all([getOrgContext(orgId), filterLookups(orgId, object)]);
  const fields = filterFields(object, {
    statuses: object === "lead" ? lookups?.statuses.map((s) => ({ value: s.id, label: s.name })) : undefined,
    sources: lookups?.sources.map((s) => ({ value: s.id, label: s.name })),
    stages: extra.stages?.map((s) => ({ value: s.id, label: s.name })),
    // hidden types too: records may still have them
    types: types.map((t) => ({ value: t.id, label: t.isActive ? t.name : `${t.name} (מוסתר)` })),
    members: members.map((m) => ({ value: m.userId, label: m.name })),
    tags: tags.map((t) => ({ value: t.id, label: t.name })),
    fields: customFields,
  });
  const tree = parseFilterParam(param);
  const ctx = { userId, now: new Date(), timeZone: context.org.timeZone };
  const built = tree ? filterToPostgrest(tree, fields, ctx) : { logic: null, skipped: 0 };
  return { fields: publicFields(fields), tree, logic: built.logic, skipped: built.skipped, applied: tree ? appliedFilter(tree, fields, ctx) : null };
}
