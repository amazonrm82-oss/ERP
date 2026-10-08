import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { asCustomValues, type FieldDefinition } from "@/features/custom-fields/types";
import type { CatalogColumn, ColumnChoice } from "@/features/list-columns/columns";
import { ListTable } from "@/features/list-columns/components/list-table";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/paths";
import type { Sort } from "@/lib/sort";

import { leadDisplayName, statusTone } from "../display";
import type { LeadListItem, LeadSourceOption, LeadStatusOption } from "../queries";

type Props = {
  orgId: string;
  leads: LeadListItem[];
  statuses: LeadStatusOption[];
  sources: LeadSourceOption[];
  // the user's columns (LST-03) and the organization's custom fields
  columns: ColumnChoice[];
  catalog: CatalogColumn[];
  fields: FieldDefinition[];
  // the current sort, and the address that sorts by a column (LST-02)
  sort: Sort<string>;
  sortHref: (key: string) => string;
};

/** Leads as a table, with the columns the user chose. */
export function LeadsTable({ orgId, leads, statuses, sources, columns, catalog, fields, sort, sortHref }: Props) {
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const sourceById = new Map(sources.map((source) => [source.id, source.name]));

  return (
    <ListTable
      label="טבלת לידים"
      rows={leads}
      rowKey={(lead) => lead.id}
      columns={columns}
      catalog={catalog}
      fields={fields}
      sort={sort}
      sortHref={sortHref}
      customValues={(lead) => asCustomValues(lead.customFields)}
      nameCell={(lead) => (
        <>
          <Link href={paths.lead(orgId, lead.id)} className="font-medium text-ink underline-offset-4 hover:underline">
            {leadDisplayName(lead)}
          </Link>
          {lead.companyName && !columns.some((c) => c.key === "company") ? (
            <span className="block text-sm text-ink-soft">{lead.companyName}</span>
          ) : null}
        </>
      )}
      cell={(key, lead) => {
        switch (key) {
          case "phone":
            return lead.phone ? (
              <span dir="ltr" className="whitespace-nowrap">
                {lead.phone}
              </span>
            ) : null;
          case "email":
            // long addresses are cut with an ellipsis; the full address is in the tooltip and on the lead's page
            return lead.email ? (
              <span dir="ltr" title={lead.email} className="block max-w-52 truncate text-end">
                {lead.email}
              </span>
            ) : null;
          case "company":
            return lead.companyName;
          case "status": {
            const status = statusById.get(lead.statusId);
            return <Badge tone={statusTone(status)}>{status?.name ?? "ללא סטטוס"}</Badge>;
          }
          case "source":
            return lead.sourceId ? sourceById.get(lead.sourceId) : null;
          case "owner":
            return lead.ownerName;
          case "created":
            return (
              <time dateTime={lead.createdAt} className="whitespace-nowrap text-ink-soft">
                {formatDate(lead.createdAt)}
              </time>
            );
          default:
            return null;
        }
      }}
    />
  );
}
