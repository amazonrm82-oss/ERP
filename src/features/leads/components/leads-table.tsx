import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { BulkSelection, RowCheck } from "@/features/bulk/components/bulk-selection";
import { asCustomValues, type FieldDefinition } from "@/features/custom-fields/types";
import { InlineEdit } from "@/features/inline-edit/components/inline-edit";
import type { InlineEditing } from "@/features/inline-edit/server";
import type { CatalogColumn, ColumnChoice } from "@/features/list-columns/columns";
import { ListTable } from "@/features/list-columns/components/list-table";
import type { TagOption } from "@/features/tags/queries";
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
  // editing name, status and owner in the cell (LST-06)
  editing: InlineEditing;
  // the organization's tags, for the bulk "add tag" (LST-07)
  tags: TagOption[];
  // the organization's active "not relevant" reasons (LEAD-03)
  reasons: string[];
  // DQL-01: the score of each row, read only when the column is shown
  completeness?: Map<string, number>;
};

/** Leads as a table, with the columns the user chose. */
export function LeadsTable({ orgId, leads, statuses, sources, columns, catalog, fields, sort, sortHref, editing, tags, reasons, completeness }: Props) {
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  // "converted" is set only by the conversion
  const statusOptions = statuses
    .filter((s) => s.kind !== "converted")
    .map((s) => ({
      value: s.id,
      label: s.name,
      needsReason: s.kind === "disqualified",
    }));
  const sourceById = new Map(sources.map((source) => [source.id, source.name]));

  return (
    <BulkSelection
      orgId={orgId}
      object="lead"
      ids={leads.map((row) => row.id)}
      owners={editing.bulk?.reassign ? editing.owners : null}
      statuses={statusOptions}
      tags={tags.map((tag) => ({ value: tag.id, label: tag.name }))}
      canTrash={editing.bulk?.trash ?? false}
      exportPath={editing.bulk?.exportable ? `${paths.leads(orgId)}/export` : null}
      enabled={editing.bulk !== null}
      reasons={reasons}
    >
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
          <div className="flex items-start gap-2">
            <RowCheck id={lead.id} label={leadDisplayName(lead)} />
            <div className="min-w-0">
              <InlineEdit
                orgId={orgId}
                object="lead"
                id={lead.id}
                field="name"
                kind="text"
                label={`שם: ${leadDisplayName(lead)}`}
                initial={{ text: lead.fullName ?? "" }}
                canEdit={editing.canEdit(lead.ownerId)}
              >
                <Link href={paths.lead(orgId, lead.id)} className="font-medium text-ink underline-offset-4 hover:underline">
                  {leadDisplayName(lead)}
                </Link>
              </InlineEdit>
              {lead.companyName && !columns.some((c) => c.key === "company") ? <span className="block text-sm text-ink-soft">{lead.companyName}</span> : null}
            </div>
          </div>
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
              return (
                <InlineEdit
                  orgId={orgId}
                  object="lead"
                  id={lead.id}
                  field="status"
                  kind="select"
                  label={`סטטוס: ${leadDisplayName(lead)}`}
                  initial={{ id: lead.statusId }}
                  options={statusOptions}
                  reasons={reasons}
                  canEdit={status?.kind !== "converted" && editing.canEdit(lead.ownerId)}
                >
                  <Badge tone={statusTone(status)}>{status?.name ?? "ללא סטטוס"}</Badge>
                </InlineEdit>
              );
            }
            case "source":
              return lead.sourceId ? sourceById.get(lead.sourceId) : null;
            case "product":
              return lead.requestedProductName ?? null;
            case "owner":
              return (
                <InlineEdit
                  orgId={orgId}
                  object="lead"
                  id={lead.id}
                  field="owner"
                  kind="select"
                  label={`אחראי: ${leadDisplayName(lead)}`}
                  initial={{ id: lead.ownerId }}
                  options={editing.owners}
                  emptyOption="ללא אחראי"
                  canEdit={editing.canReassign(lead.ownerId)}
                >
                  {lead.ownerName}
                </InlineEdit>
              );
            case "last_contact":
              return lead.lastContactedAt ? (
                <time dateTime={lead.lastContactedAt} className="whitespace-nowrap text-ink-soft">
                  {formatDate(lead.lastContactedAt)}
                </time>
              ) : (
                <span className="text-ink-soft">אין עדיין</span>
              );
            case "completeness": {
              const score = completeness?.get(lead.id);
              return score === undefined ? null : <span className="tabular-nums">{score}%</span>;
            }
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
    </BulkSelection>
  );
}
