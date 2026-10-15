import "server-only";

import { canExportWith } from "@/features/permissions/keys";
import type { MembershipRole } from "@/lib/database.types";
import { isUuid } from "@/lib/paths";
import { firstParam } from "@/lib/search";

import type { ReportFilters } from "./build";
import type { ReportDefinition } from "./definitions";
import { parsePeriod } from "./period";

type SearchParams = Record<string, string | string[] | undefined>;

/** Filters from the query string; anything malformed is ignored. */
export function reportFilters(definition: ReportDefinition, params: SearchParams): ReportFilters {
  const owner = firstParam(params.owner);
  const pipeline = firstParam(params.pipeline);
  return {
    period: parsePeriod({ period: firstParam(params.period), from: firstParam(params.from), to: firstParam(params.to) }),
    ownerId: definition.filters.includes("owner") && isUuid(owner) ? owner : null,
    pipelineId: definition.filters.includes("pipeline") && isUuid(pipeline) ? pipeline : null,
  };
}

/** The same filters as a query string, for the export link. */
export function filtersQuery(filters: ReportFilters): string {
  const query = new URLSearchParams({ period: filters.period.key });
  if (filters.period.key === "custom") {
    query.set("from", filters.period.fromDate);
    query.set("to", filters.period.toDate);
  }
  if (filters.ownerId) query.set("owner", filters.ownerId);
  if (filters.pipelineId) query.set("pipeline", filters.pipelineId);
  return query.toString();
}

/**
 * Owners, admins and team managers may export (SPEC 7.1: members do not export), and a
 * member with the export permission (PRM-01; `granted` from getMyPermissions()). Mirrors
 * app.can_export(); the database checks it again in log_list_export / log_export.
 */
export function canExport(role: MembershipRole, granted: readonly string[]): boolean {
  return canExportWith(role, granted);
}
