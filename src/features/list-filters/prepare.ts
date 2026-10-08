import "server-only";

import type { FieldDefinition } from "@/features/custom-fields/types";
import { getLeadLookups } from "@/features/leads/queries";
import { listMembers } from "@/features/settings/queries";
import { listTags } from "@/features/tags/queries";

import { parseFilterParam } from "./model";
import { filterFields, filterToPostgrest, publicFields, type FilterObject, type PreparedFilter } from "./server";

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
  const [lookups, members, tags] = await Promise.all([
    object === "lead" || object === "contact" ? getLeadLookups(orgId) : null,
    listMembers(orgId),
    object === "task" ? [] : listTags(orgId),
  ]);
  const fields = filterFields(object, {
    statuses: object === "lead" ? lookups?.statuses.map((s) => ({ value: s.id, label: s.name })) : undefined,
    sources: lookups?.sources.map((s) => ({ value: s.id, label: s.name })),
    stages: extra.stages?.map((s) => ({ value: s.id, label: s.name })),
    members: members.map((m) => ({ value: m.userId, label: m.name })),
    tags: tags.map((t) => ({ value: t.id, label: t.name })),
    fields: customFields,
  });
  const tree = parseFilterParam(param);
  const built = tree ? filterToPostgrest(tree, fields, { userId, now: new Date() }) : { logic: null, skipped: 0 };
  return { fields: publicFields(fields), tree, logic: built.logic, skipped: built.skipped };
}
