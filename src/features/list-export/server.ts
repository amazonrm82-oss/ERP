import "server-only";

import { listCompanies, COMPANY_DEFAULT_SORT, COMPANY_SORT_COLUMNS } from "@/features/companies/queries";
import { contactDisplayName } from "@/features/contacts/display";
import { CONTACT_DEFAULT_SORT, CONTACT_SORT_COLUMNS, listContacts } from "@/features/contacts/queries";
import { asCustomValues } from "@/features/custom-fields/types";
import { displayCustomFields } from "@/features/custom-fields/values";
import { leadDisplayName } from "@/features/leads/display";
import { getLeadLookups, LEAD_DEFAULT_SORT, LEAD_SORT_COLUMNS, listLeads } from "@/features/leads/queries";
import { CUSTOM_PREFIX, resolveColumns, type ListObject } from "@/features/list-columns/columns";
import { getListColumns } from "@/features/list-columns/queries";
import { prepareListFilter } from "@/features/list-filters/prepare";
import { canExport } from "@/features/reports/request";
import { getOrgContext } from "@/features/shell/queries";
import { viewChips } from "@/features/views/server";
import { csvText } from "@/lib/csv";
import type { Json } from "@/lib/database.types";
import { formatDate, zoneDate } from "@/lib/format";
import { isUuid } from "@/lib/paths";
import { parseSort, type CustomSortKey, type Sort } from "@/lib/sort";
import { createClient } from "@/lib/supabase/server";
import { xlsxFile } from "@/lib/xlsx";

// Exporting a list (LST-08): the rows the list shows with its filters, search
// and sort (or only the rows picked in it), in the columns the user sees, as
// CSV or Excel. Read with the user's session, so RLS decides as on screen;
// for owners, admins and team managers only, and written to the audit log first.

const CHUNK = 1000;
// past this, the full export (settings) is the tool
const MAX_ROWS = 50000;
const MAX_PICKED = 100;

const SHEET = { lead: "לידים", contact: "אנשי קשר", company: "חברות" } as const;
const FILE = { lead: "leads", contact: "contacts", company: "companies" } as const;

const text = (message: string, status: number) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

// a row as the export needs it: its id, its name, the built-in cells, and its custom fields
type ExportRow = { name: string; cells: Record<string, string | null>; customFields: Json };

export async function exportList(request: Request, orgId: string, object: ListObject): Promise<Response> {
  const context = await getOrgContext(orgId);
  if (!canExport(context.role)) {
    return text("ייצוא מותר לבעלים, למנהלי מערכת ולמנהלי צוות.", 403);
  }
  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "xlsx" ? "xlsx" : "csv";
  const picked = (params.get("ids") ?? "").split(",").filter(isUuid);
  if (picked.length > MAX_PICKED) {
    return text(`אפשר לייצא עד ${MAX_PICKED} רשומות נבחרות. לייצוא של יותר, השתמשו בסינון.`, 400);
  }
  const scope = params.has("ids") ? "selected" : "filtered";

  const listColumns = await getListColumns(orgId, object);
  const filter = await prepareListFilter(orgId, object, params.get("f") ?? "", context.user.id, listColumns.fields);
  const search = (params.get("q") ?? "").trim();
  const tagId = isUuid(params.get("tag") ?? "") ? params.get("tag") : null;
  const statusId = object === "lead" && isUuid(params.get("status") ?? "") ? params.get("status") : null;
  const sortColumns = object === "lead" ? LEAD_SORT_COLUMNS : object === "contact" ? CONTACT_SORT_COLUMNS : COMPANY_SORT_COLUMNS;
  const defaultSort = object === "lead" ? LEAD_DEFAULT_SORT : object === "contact" ? CONTACT_DEFAULT_SORT : COMPANY_DEFAULT_SORT;
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
  const rows: ExportRow[] = [];
  const lookups = object === "lead" ? await getLeadLookups(orgId) : null;
  const statusName = new Map(lookups?.statuses.map((s) => [s.id, s.name]) ?? []);
  const sourceName = new Map(lookups?.sources.map((s) => [s.id, s.name]) ?? []);
  const created = (iso: string) => formatDate(iso);

  for (let from = 0; ; from += CHUNK) {
    const chunk = { from, size: CHUNK };
    let more: boolean;
    if (object === "lead") {
      const page = await listLeads(orgId, { ...options, statusId: scope === "selected" ? null : statusId, chunk });
      more = page.hasMore;
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
            created: created(lead.createdAt),
          },
        });
      }
    } else if (object === "contact") {
      const page = await listContacts(orgId, { ...options, chunk });
      more = page.hasMore;
      for (const contact of page.contacts) {
        rows.push({
          name: contactDisplayName(contact),
          customFields: contact.customFields,
          cells: {
            phone: contact.phone,
            email: contact.email,
            job_title: contact.jobTitle,
            company: contact.companyName,
            owner: contact.ownerName,
            created: created(contact.createdAt),
          },
        });
      }
    } else {
      const page = await listCompanies(orgId, { ...options, chunk });
      more = page.hasMore;
      for (const company of page.companies) {
        rows.push({
          name: company.name,
          customFields: company.customFields,
          cells: { phone: company.phone, city: company.city, website: company.website, owner: company.ownerName, created: created(company.createdAt) },
        });
      }
    }
    if (rows.length > MAX_ROWS) {
      return text(`ברשימה יותר מ-${MAX_ROWS.toLocaleString("he-IL")} שורות. צמצמו בסינון, או השתמשו בייצוא המלא בהגדרות.`, 413);
    }
    if (!more) break;
  }

  const header = ["שם", ...columns.map((column) => labels.get(column.key) ?? column.key)];
  const body = rows.map((row) => [
    row.name,
    ...columns.map((column) => {
      const field = fieldByKey.get(column.key);
      if (field) return displayCustomFields([field], asCustomValues(row.customFields))[0].text ?? "";
      return row.cells[column.key] ?? "";
    }),
  ]);

  // the audit entry comes first: no entry, no file
  const supabase = await createClient();
  const filters: Record<string, string | number> =
    scope === "selected"
      ? { picked: picked.length }
      : Object.fromEntries(
          Object.entries({
            q: search,
            tag: tagId ?? "",
            status: statusId ?? "",
            f: filter.tree ? JSON.stringify(filter.tree) : "",
            sort: params.get("sort") ?? "",
            view: view?.name ?? "",
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
      error.code === "42501" ? "ייצוא מותר לבעלים, למנהלי מערכת ולמנהלי צוות." : "לא הצלחנו להכין את הקובץ. נסו שוב.",
      error.code === "42501" ? 403 : 500,
    );
  }

  const filename = `${FILE[object]}-${zoneDate(new Date())}.${format}`;
  if (format === "xlsx") {
    return new Response(xlsxFile(SHEET[object], header, body) as unknown as BodyInit, {
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
