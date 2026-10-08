import Link from "next/link";

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

import type { CompanyListItem } from "../queries";

type Props = {
  orgId: string;
  companies: CompanyListItem[];
  // the user's columns (LST-03) and the organization's custom fields
  columns: ColumnChoice[];
  catalog: CatalogColumn[];
  fields: FieldDefinition[];
  // the current sort, and the address that sorts by a column (LST-02)
  sort: Sort<string>;
  sortHref: (key: string) => string;
  // editing name and owner in the cell (LST-06)
  editing: InlineEditing;
  // the organization's tags, for the bulk "add tag" (LST-07)
  tags: TagOption[];
};

/** Companies as a table, with the columns the user chose. */
export function CompaniesTable({ orgId, companies, columns, catalog, fields, sort, sortHref, editing, tags }: Props) {
  return (
    <BulkSelection
      orgId={orgId}
      object="company"
      ids={companies.map((row) => row.id)}
      owners={editing.bulk?.reassign ? editing.owners : null}
      statuses={null}
      tags={tags.map((tag) => ({ value: tag.id, label: tag.name }))}
      canTrash={editing.bulk?.trash ?? false}
      exportPath={editing.bulk?.exportable ? `${paths.companies(orgId)}/export` : null}
      enabled={editing.bulk !== null}
    >
      <ListTable
        label="טבלת חברות"
        rows={companies}
        rowKey={(company) => company.id}
        columns={columns}
        catalog={catalog}
        fields={fields}
        sort={sort}
        sortHref={sortHref}
        customValues={(company) => asCustomValues(company.customFields)}
        nameCell={(company) => (
          <div className="flex items-start gap-2">
            <RowCheck id={company.id} label={company.name} />
            <InlineEdit
              orgId={orgId}
              object="company"
              id={company.id}
              field="name"
              kind="text"
              label={`שם: ${company.name}`}
              initial={{ text: company.name }}
              canEdit={editing.canEdit(company.ownerId)}
            >
              <Link href={paths.company(orgId, company.id)} className="font-medium text-ink underline-offset-4 hover:underline">
                {company.name}
              </Link>
            </InlineEdit>
          </div>
        )}
        cell={(key, company) => {
          switch (key) {
            case "phone":
              return company.phone ? (
                <span dir="ltr" className="whitespace-nowrap">
                  {company.phone}
                </span>
              ) : null;
            case "city":
              return company.city;
            case "website":
              return company.website ? (
                <span dir="ltr" title={company.website} className="block max-w-52 truncate text-end">
                  {company.website}
                </span>
              ) : null;
            case "owner":
              return (
                <InlineEdit
                  orgId={orgId}
                  object="company"
                  id={company.id}
                  field="owner"
                  kind="select"
                  label={`בעלים: ${company.name}`}
                  initial={{ id: company.ownerId }}
                  options={editing.owners}
                  emptyOption="ללא בעלים"
                  canEdit={editing.canReassign(company.ownerId)}
                >
                  {company.ownerName}
                </InlineEdit>
              );
            case "created":
              return (
                <time dateTime={company.createdAt} className="whitespace-nowrap text-ink-soft">
                  {formatDate(company.createdAt)}
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
