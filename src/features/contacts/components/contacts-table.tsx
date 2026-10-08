import Link from "next/link";

import { InlineEdit } from "@/features/inline-edit/components/inline-edit";
import type { InlineEditing } from "@/features/inline-edit/server";
import { asCustomValues, type FieldDefinition } from "@/features/custom-fields/types";
import type { CatalogColumn, ColumnChoice } from "@/features/list-columns/columns";
import { ListTable } from "@/features/list-columns/components/list-table";
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
};

/** Contacts as a table, with the columns the user chose. */
export function ContactsTable({ orgId, contacts, columns, catalog, fields, sort, sortHref, editing }: Props) {
  return (
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
        <>
          <InlineEdit
            orgId={orgId}
            object="contact"
            id={contact.id}
            field="name"
            kind="person"
            label={`שם: ${contactDisplayName(contact)}`}
            initial={{ first: contact.firstName ?? "", last: contact.lastName ?? "" }}
            canEdit={editing.canEdit(contact.ownerId)}
          >
            <Link href={paths.contact(orgId, contact.id)} className="font-medium text-ink underline-offset-4 hover:underline">
              {contactDisplayName(contact)}
            </Link>
          </InlineEdit>
          {contact.jobTitle && !columns.some((c) => c.key === "job_title") ? (
            <span className="block text-sm text-ink-soft">{contact.jobTitle}</span>
          ) : null}
        </>
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
          case "owner":
            return (
              <InlineEdit
                orgId={orgId}
                object="contact"
                id={contact.id}
                field="owner"
                kind="select"
                label={`בעלים: ${contactDisplayName(contact)}`}
                initial={{ id: contact.ownerId }}
                options={editing.owners}
                emptyOption="ללא בעלים"
                canEdit={editing.canReassign(contact.ownerId)}
              >
                {contact.ownerName}
              </InlineEdit>
            );
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
  );
}
