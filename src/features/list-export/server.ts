import "server-only";

import { listCompanies, COMPANY_DEFAULT_SORT, COMPANY_SORT_COLUMNS } from "@/features/companies/queries";
import { contactDisplayName } from "@/features/contacts/display";
import { channelLabel, localeLabel } from "@/features/contacts/preferences";
import { DEAL_STATUS } from "@/features/deals/display";
import { BILLING_KIND_LABELS, billingKindOf, recurringText } from "@/features/deals/recurring";
import { DEAL_DEFAULT_SORT, DEAL_SORT_COLUMNS, getPipeline, listDeals } from "@/features/deals/queries";
import { CONTACT_DEFAULT_SORT, CONTACT_SORT_COLUMNS, listContacts } from "@/features/contacts/queries";
import { asCustomValues } from "@/features/custom-fields/types";
import { displayCustomFields } from "@/features/custom-fields/values";
import { getScoreNumbers } from "@/features/data-quality/queries";
import { leadDisplayName } from "@/features/leads/display";
import { getLeadLookups, LEAD_DEFAULT_SORT, LEAD_SORT_COLUMNS, listLeads } from "@/features/leads/queries";
import { CUSTOM_PREFIX, resolveColumns, type ListObject } from "@/features/list-columns/columns";
import { getListColumns } from "@/features/list-columns/queries";
import { prepareListFilter } from "@/features/list-filters/prepare";
import { getMyPermissions } from "@/features/permissions/queries";
import { canExport } from "@/features/reports/request";
import { getOrgContext } from "@/features/shell/queries";
import { listTasks, TASK_DEFAULT_SORT, TASK_SORT_COLUMNS, type TaskSortKey } from "@/features/tasks/queries";
import { viewChips } from "@/features/views/server";
import { csvText } from "@/lib/csv";
import type { Json } from "@/lib/database.types";
import { formatDate, formatDateTime, formatMoney, zoneDate } from "@/lib/format";
import { isUuid } from "@/lib/paths";
import { parseSort, sortValue, type CustomSortKey, type Sort } from "@/lib/sort";
import { createClient } from "@/lib/supabase/server";
import { xlsxFile } from "@/lib/xlsx";
import { readAllPages } from "@/lib/paged-read";
import { RECORD_TYPES } from "@/lib/record-types";

// Exporting a list (LST-08): the rows the list shows with its filters, search
// and sort (or only the rows picked in it), in the columns the user sees, as
// CSV or Excel. Read with the user's session, so RLS decides as on screen;
// for owners, admins and team managers only, and written to the audit log first.

// past this, the full export (settings) is the tool
const MAX_ROWS = 50000;
const MAX_PICKED = 100;

const TASK_STATUS_LABELS = { open: "פתוחה", done: "הושלמה", cancelled: "בוטלה" } as const;
const PRIORITY_LABELS: Record<number, string> = { 1: "גבוהה", 2: "רגילה", 3: "נמוכה" };

const text = (message: string, status: number) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

// a row as the export needs it: its id, its name, the built-in cells, and its custom fields
type ExportRow = { name: string; cells: Record<string, string | null>; customFields: Json };

// the product catalog, the quotes, documents and payments lists have their own exports (export-server.ts in each feature folder)
export async function exportList(request: Request, orgId: string, object: Exclude<ListObject, "product" | "quote" | "document" | "payment">): Promise<Response> {
  const context = await getOrgContext(orgId);
  // PRM-01: extra permissions (export)
  const granted = await getMyPermissions(orgId);
  if (!canExport(context.role, granted)) {
    return text("ייצוא מותר לבעלים, למנהלי מערכת, למנהלי צוות ולמי שקיבל הרשאת ייצוא.", 403);
  }
  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "xlsx" ? "xlsx" : "csv";
  const picked = (params.get("ids") ?? "").split(",").filter(isUuid);
  if (picked.length > MAX_PICKED) {
    return text(`אפשר לייצא עד ${MAX_PICKED} רשומות נבחרות. לייצוא של יותר, השתמשו בסינון.`, 400);
  }
  const scope = params.has("ids") ? "selected" : "filtered";

  const listColumns = await getListColumns(orgId, object);
  // the deals table shows one pipeline; tasks are the user's own unless "who=all"
  const pipeline = object === "deal" ? await getPipeline(orgId, params.get("pipeline")) : null;
  if (object === "deal" && !pipeline) {
    return text("אין תהליך מכירה.", 404);
  }
  const taskOwner = object === "task" && params.get("who") !== "all" ? context.user.id : null;
  const filter = await prepareListFilter(orgId, object, params.get("f") ?? "", context.user.id, listColumns.fields, { stages: pipeline?.stages });
  const search = (params.get("q") ?? "").trim();
  const tagId = isUuid(params.get("tag") ?? "") ? params.get("tag") : null;
  const statusId = object === "lead" && isUuid(params.get("status") ?? "") ? params.get("status") : null;
  const sortColumns = { lead: LEAD_SORT_COLUMNS, contact: CONTACT_SORT_COLUMNS, company: COMPANY_SORT_COLUMNS, deal: DEAL_SORT_COLUMNS, task: TASK_SORT_COLUMNS }[object];
  const defaultSort = { lead: LEAD_DEFAULT_SORT, contact: CONTACT_DEFAULT_SORT, company: COMPANY_DEFAULT_SORT, deal: DEAL_DEFAULT_SORT, task: TASK_DEFAULT_SORT }[object];
  const sortKeys = [...Object.keys(sortColumns), ...listColumns.fields.map((f) => `${CUSTOM_PREFIX}${f.key}`)] as Array<CustomSortKey>;
  const sort = parseSort(params.get("sort") ?? "", sortKeys, defaultSort as unknown as Sort<CustomSortKey>);

  // the columns of the open view, or the user's own
  const viewId = params.get("sv");
  const view = viewId ? (await viewChips(orgId, object, context)).chips.find((v) => v.id === viewId) : null;
  const columns = view?.config.columns ? resolveColumns(object, view.config.columns, listColumns.catalog) : listColumns.columns;
  const labels = new Map(listColumns.catalog.map((column) => [column.key, column.label]));
  const fieldByKey = new Map(listColumns.fields.map((field) => [`${CUSTOM_PREFIX}${field.key}`, field]));

  // picked rows ignore the list's filters: they were picked on screen
  const options = scope === "selected" ? { search: "", page: 1, sort, ids: picked } : { search, tagId, page: 1, sort, filter: filter.logic };
  const lookups = object === "lead" ? await getLeadLookups(orgId) : null;
  const statusName = new Map(lookups?.statuses.map((s) => [s.id, s.name]) ?? []);
  const sourceName = new Map(lookups?.sources.map((s) => [s.id, s.name]) ?? []);
  const stageName = new Map(pipeline?.stages.map((s) => [s.id, s.name]) ?? []);
  const created = (iso: string) => formatDate(iso);
  // DQL-01: the completeness column is read only when it is exported
  const withScores = columns.some((column) => column.key === "completeness");
  const percent = (score: number | undefined) => (score === undefined ? null : `${score}%`);

  // one page of the list as export rows; read page after page until a short page (RVW-2: a read
  // returns at most 1,000 rows, so asking for more and stopping when fewer came back lost rows)
  const readPage = async (from: number, to: number): Promise<ExportRow[]> => {
    const chunk = { from, size: to - from + 1 };
    const rows: ExportRow[] = [];
    if (object === "lead") {
      const page = await listLeads(orgId, { ...options, statusId: scope === "selected" ? null : statusId, chunk });
      const scores = withScores ? await getScoreNumbers(orgId, "lead", page.leads.map((lead) => lead.id)) : null;
      for (const lead of page.leads) {
        rows.push({
          name: leadDisplayName(lead),
          customFields: lead.customFields,
          cells: {
            phone: lead.phone,
            email: lead.email,
            company: lead.companyName,
            status: statusName.get(lead.statusId) ?? null,
            source: lead.sourceId ? (sourceName.get(lead.sourceId) ?? null) : null,
            owner: lead.ownerName,
            last_contact: lead.lastContactedAt ? created(lead.lastContactedAt) : null,
            product: lead.requestedProductName ?? null,
            created: created(lead.createdAt),
            completeness: percent(scores?.get(lead.id)),
            score: lead.score === undefined ? null : String(lead.score),
          },
        });
      }
    } else if (object === "contact") {
      const page = await listContacts(orgId, { ...options, chunk });
      const scores = withScores ? await getScoreNumbers(orgId, "contact", page.contacts.map((contact) => contact.id)) : null;
      for (const contact of page.contacts) {
        rows.push({
          name: contactDisplayName(contact),
          customFields: contact.customFields,
          cells: {
            phone: contact.phone,
            email: contact.email,
            job_title: contact.jobTitle,
            company: contact.companyName,
            type: contact.typeName,
            locale: localeLabel(contact.preferredLocale),
            channel: channelLabel(contact.preferredChannel),
            owner: contact.ownerName,
            created: created(contact.createdAt),
            completeness: percent(scores?.get(contact.id)),
          },
        });
      }
    } else if (object === "deal") {
      const page = await listDeals(orgId, { ...options, pipelineId: pipeline!.id, chunk });
      for (const deal of page.deals) {
        rows.push({
          name: deal.name,
          customFields: deal.customFields,
          cells: {
            amount: formatMoney(deal.amountAgorot),
            stage: stageName.get(deal.stageId) ?? null,
            status: DEAL_STATUS[deal.status].label,
            contact: deal.contactName,
            company: deal.companyName,
            owner: deal.ownerName,
            expected_close: deal.expectedCloseDate ? formatDate(deal.expectedCloseDate) : null,
            billing_kind: BILLING_KIND_LABELS[billingKindOf(deal.billingKind)],
            recurring_amount: recurringText(deal.billingKind, deal.recurringAmountAgorot),
            recurring_start: deal.recurringStartDate ? formatDate(deal.recurringStartDate) : null,
            renewal: deal.renewalDate ? formatDate(deal.renewalDate) : null,
            created: created(deal.createdAt),
          },
        });
      }
    } else if (object === "task") {
      const page = await listTasks(orgId, { ...options, ownerId: scope === "selected" ? null : taskOwner, sort: sort as unknown as Sort<TaskSortKey>, chunk });
      for (const task of page.tasks) {
        rows.push({
          name: task.title,
          customFields: {},
          cells: {
            due: task.dueAt ? formatDateTime(task.dueAt) : null,
            type: task.typeName,
            status: TASK_STATUS_LABELS[task.status],
            priority: PRIORITY_LABELS[task.priority] ?? null,
            related: task.related?.name ?? null,
            parent: task.parent ? (task.parent.title ?? "משימה") : null,
            owner: task.ownerName,
            created: created(task.createdAt),
          },
        });
      }
    } else {
      const page = await listCompanies(orgId, { ...options, chunk });
      for (const company of page.companies) {
        rows.push({
          name: company.name,
          customFields: company.customFields,
          cells: {
            phone: company.phone,
            city: company.city,
            website: company.website,
            type: company.typeName,
            owner: company.ownerName,
            created: created(company.createdAt),
          },
        });
      }
    }
    return rows;
  };
  const { rows, complete } = await readAllPages(readPage, { limit: MAX_ROWS });
  if (!complete) {
    return text(`ברשימה יותר מ-${MAX_ROWS.toLocaleString("he-IL")} שורות. צמצמו בסינון, או השתמשו בייצוא המלא בהגדרות.`, 413);
  }

  const header = [object === "task" ? "כותרת" : "שם", ...columns.map((column) => labels.get(column.key) ?? column.key)];
  const body = rows.map((row) => [
    row.name,
    ...columns.map((column) => {
      const field = fieldByKey.get(column.key);
      if (field) return displayCustomFields([field], asCustomValues(row.customFields))[0].text ?? "";
      return row.cells[column.key] ?? "";
    }),
  ]);

  // the audit entry comes first: no entry, no file. log_list_export() keeps only the shape of the
  // filters (RVW-4): the search becomes "a search was used", the pipeline and view go as ids, and a
  // filter value only when it fits its operator
  const supabase = await createClient();
  const filters: Record<string, string | number> =
    scope === "selected"
      ? { picked: picked.length }
      : Object.fromEntries(
          Object.entries({
            q: search,
            tag: tagId ?? "",
            status: statusId ?? "",
            // only the conditions the list applied, and the sort it used (a real column key)
            f: filter.applied ? JSON.stringify(filter.applied) : "",
            sort: sortValue(sort),
            pipeline: pipeline?.id ?? "",
            who: object === "task" ? (taskOwner ? "mine" : "all") : "",
            view: view?.id ?? "",
          }).filter(([, value]) => value !== ""),
        );
  const { error } = await supabase.rpc("log_list_export", {
    p_org: orgId,
    p_object: object,
    p_format: format,
    p_rows: rows.length,
    p_scope: scope,
    p_filters: filters,
  });
  if (error) {
    return text(
      error.code === "42501" ? "ייצוא מותר לבעלים, למנהלי מערכת, למנהלי צוות ולמי שקיבל הרשאת ייצוא." : "לא הצלחנו להכין את הקובץ. נסו שוב.",
      error.code === "42501" ? 403 : 500,
    );
  }

  const filename = `${RECORD_TYPES[object].table}-${zoneDate(new Date())}.${format}`;
  if (format === "xlsx") {
    return new Response(xlsxFile(RECORD_TYPES[object].plural, header, body) as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const lines = [header, ...body].map((values) => values.map((value) => csvText(value)).join(","));
  // BOM: Excel opens UTF-8 Hebrew correctly only with it
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" },
  });
}
