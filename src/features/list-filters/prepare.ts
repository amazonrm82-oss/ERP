import "server-only";

import { listActivityTypes } from "@/features/activity-types/queries";
import { moneyColumnsEnabled } from "@/features/allocations/queries";
import { listCompanyOptions } from "@/features/companies/queries";
import type { FieldDefinition } from "@/features/custom-fields/types";
import { getLeadLookups } from "@/features/leads/queries";
import { listProductCategories, listProductUnits } from "@/features/products/list-queries";
import { categoryOptions } from "@/features/products/lists";
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
    // products have no owner
    object === "product" ? [] : listMembers(orgId),
    // tasks, products, quotes, documents and payments have no tags
    object === "task" || object === "product" || object === "quote" || object === "document" || object === "payment" ? [] : listTags(orgId),
    object === "contact" || object === "company" ? listRecordTypes(orgId, object) : [],
    // TASK-08: the business's activity and task types
    object === "task" ? listActivityTypes(orgId) : [],
    // PAY-03: "יש יתרת זכות" on contacts and companies, with the money keys (read once per request)
    object === "contact" || object === "company" ? moneyColumnsEnabled(orgId) : false,
  ]);
}

// LST-09: the product catalog's categories and units, for its filter
function productLookups(orgId: string, object: FilterObject) {
  return object === "product" ? Promise.all([listProductCategories(orgId), listProductUnits(orgId)]) : Promise.resolve([[], []] as const);
}

/**
 * Starts reading the filter's choices, so a list page can run them next to its columns (FXC-09) instead of after
 * them. Resolves to nothing; prepareListFilter() then gets the same reads from the request's memo.
 */
export async function startListFilterLookups(orgId: string, object: FilterObject): Promise<void> {
  await Promise.all([filterLookups(orgId, object), productLookups(orgId, object)]);
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
  const [context, [lookups, members, tags, types, activityTypes, money], companies, [categories, units]] = await Promise.all([
    getOrgContext(orgId),
    filterLookups(orgId, object),
    // CON-05: the primary company of a contact
    object === "contact" ? listCompanyOptions(orgId) : [],
    productLookups(orgId, object),
  ]);
  const fields = filterFields(object, {
    statuses: object === "lead" ? lookups?.statuses.map((s) => ({ value: s.id, label: s.name })) : undefined,
    sources: lookups?.sources.map((s) => ({ value: s.id, label: s.name })),
    stages: extra.stages?.map((s) => ({ value: s.id, label: s.name })),
    // hidden types too: records may still have them
    types: types.map((t) => ({ value: t.id, label: t.isActive ? t.name : `${t.name} (מוסתר)` })),
    activityTypes: activityTypes.map((t) => ({ value: t.id, label: t.isActive ? t.name : `${t.name} (מוסתר)` })),
    companies: companies.map((c) => ({ value: c.id, label: c.name })),
    categories: categoryOptions(categories).map((c) => ({ value: c.id, label: c.label })),
    units: units.map((u) => ({ value: u.id, label: u.name })),
    money,
    members: members.map((m) => ({ value: m.userId, label: m.name })),
    tags: tags.map((t) => ({ value: t.id, label: t.name })),
    fields: customFields,
  });
  const tree = parseFilterParam(param);
  const ctx = { userId, now: new Date(), timeZone: context.org.timeZone };
  const built = tree ? filterToPostgrest(tree, fields, ctx) : { logic: null, skipped: 0 };
  return { fields: publicFields(fields), tree, logic: built.logic, skipped: built.skipped, applied: tree ? appliedFilter(tree, fields, ctx) : null };
}
