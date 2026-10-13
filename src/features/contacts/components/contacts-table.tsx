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

import { contactDisplayName } from "../display";
import type { ContactListItem } from "../queries";

type Props = {
  orgId: string;
  contacts: ContactListItem[];
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
  // DQL-01: the score of each row, read only when the column is shown
  completeness?: Map<string, number>;
};

/** Contacts as a table, with the columns the user chose. */
export function ContactsTable({ orgId, contacts, columns, catalog, fields, sort, sortHref, editing, tags, completeness }: Props) {
  return (
    <BulkSelection
      orgId={orgId}
      object="contact"
      ids={contacts.map((row) => row.id)}
      owners={editing.bulk?.reassign ? editing.owners : null}
      statuses={null}
      tags={tags.map((tag) => ({ value: tag.id, label: tag.name }))}
      canTrash={editing.bulk?.trash ?? false}
      exportPath={editing.bulk?.exportable ? `${paths.contacts(orgId)}/export` : null}
      enabled={editing.bulk !== null}
    >
      <ListTable
        label="טבלת אנשי קשר"
        rows={contacts}
        rowKey={(contact) => contact.id}
        columns={columns}
        catalog={catalog}
        fields={fields}
        sort={sort}
        sortHref={sortHref}
        customValues={(contact) => asCustomValues(contact.customFields)}
        nameCell={(contact) => (
          <div className="flex items-start gap-2">
            <RowCheck id={contact.id} label={contactDisplayName(contact)} />
            <div className="min-w-0">
              <InlineEdit
                orgId={orgId}
                object="contact"
                id={contact.id}
                field="name"
                kind="person"
                label={`שם: ${contactDisplayName(contact)}`}
                initial={{
                  first: contact.firstName ?? "",
                  last: contact.lastName ?? "",
                }}
                canEdit={editing.canEdit(contact.ownerId)}
              >
                <Link href={paths.contact(orgId, contact.id)} className="font-medium text-ink underline-offset-4 hover:underline">
                  {contactDisplayName(contact)}
                </Link>
              </InlineEdit>
              {contact.jobTitle && !columns.some((c) => c.key === "job_title") ? <span className="block text-sm text-ink-soft">{contact.jobTitle}</span> : null}
            </div>
          </div>
        )}
        cell={(key, contact) => {
          switch (key) {
            case "phone":
              return contact.phone ? (
                <span dir="ltr" className="whitespace-nowrap">
                  {contact.phone}
                </span>
              ) : null;
            case "email":
              return contact.email ? (
                <span dir="ltr" title={contact.email} className="block max-w-52 truncate text-end">
                  {contact.email}
                </span>
              ) : null;
            case "job_title":
              return contact.jobTitle;
            case "company":
              return contact.companyName;
            case "type":
              return contact.typeName;
            case "owner":
              return (
                <InlineEdit
                  orgId={orgId}
                  object="contact"
                  id={contact.id}
                  field="owner"
                  kind="select"
                  label={`אחראי: ${contactDisplayName(contact)}`}
                  initial={{ id: contact.ownerId }}
                  options={editing.owners}
                  emptyOption="ללא אחראי"
                  canEdit={editing.canReassign(contact.ownerId)}
                >
                  {contact.ownerName}
                </InlineEdit>
              );
            case "completeness": {
              const score = completeness?.get(contact.id);
              return score === undefined ? null : <span className="tabular-nums">{score}%</span>;
            }
            case "created":
              return (
                <time dateTime={contact.createdAt} className="whitespace-nowrap text-ink-soft">
                  {formatDate(contact.createdAt)}
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
