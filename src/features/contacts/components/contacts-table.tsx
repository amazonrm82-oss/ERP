import Link from "next/link";

import { SortableHeader } from "@/components/sortable-header";

import { formatDate } from "@/lib/format";
import { paths } from "@/lib/paths";
import type { Sort } from "@/lib/sort";

import { contactDisplayName } from "../display";
import type { ContactListItem, ContactSortKey } from "../queries";

const th = "px-4 py-2.5 text-start text-sm font-medium text-ink-soft whitespace-nowrap";
const td = "px-4 py-3 align-top";

type Props = {
  orgId: string;
  contacts: ContactListItem[];
  // the current sort, and the address that sorts by a column (LST-02)
  sort: Sort<ContactSortKey>;
  sortHref: (key: ContactSortKey) => string;
};

/** Contacts as a table; secondary columns drop out on narrow screens. */
export function ContactsTable({ orgId, contacts, sort, sortHref }: Props) {
  const header = (key: ContactSortKey, label: string, className: string) => (
    <SortableHeader
      label={label}
      className={className}
      direction={sort.key === key ? (sort.ascending ? "ascending" : "descending") : null}
      href={sortHref(key)}
    />
  );
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-[0.9375rem]">
        <thead className="border-b border-line bg-canvas/60">
          <tr>
            {header("name", "שם", `${th} sm:min-w-52`)}
            {header("phone", "טלפון", `${th} hidden sm:table-cell`)}
            {header("email", "אימייל", `${th} hidden md:table-cell`)}
            {header("company", "חברה", `${th} hidden lg:table-cell`)}
            {header("owner", "בעלים", `${th} hidden xl:table-cell`)}
            {header("created", "נוצר", `${th} hidden lg:table-cell`)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {contacts.map((contact) => (
            <tr key={contact.id} className="hover:bg-canvas/50">
              <td className={td}>
                <Link href={paths.contact(orgId, contact.id)} className="font-medium text-ink underline-offset-4 hover:underline">
                  {contactDisplayName(contact)}
                </Link>
                {contact.jobTitle ? <span className="block text-sm text-ink-soft">{contact.jobTitle}</span> : null}
                {contact.phone && (contact.fullName || contact.email) ? (
                  <span dir="ltr" className="block text-end text-sm text-ink-soft sm:hidden">
                    {contact.phone}
                  </span>
                ) : null}
              </td>
              <td className={`${td} hidden whitespace-nowrap sm:table-cell`}>
                {contact.phone ? <span dir="ltr">{contact.phone}</span> : null}
              </td>
              <td className={`${td} hidden md:table-cell`}>
                {contact.email ? (
                  <span dir="ltr" title={contact.email} className="block max-w-52 truncate text-end">
                    {contact.email}
                  </span>
                ) : null}
              </td>
              <td className={`${td} hidden lg:table-cell`}>{contact.companyName}</td>
              <td className={`${td} hidden whitespace-nowrap xl:table-cell`}>{contact.ownerName}</td>
              <td className={`${td} hidden whitespace-nowrap text-ink-soft lg:table-cell`}>
                <time dateTime={contact.createdAt}>{formatDate(contact.createdAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
