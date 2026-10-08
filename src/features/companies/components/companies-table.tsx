import Link from "next/link";

import { asCustomValues, type FieldDefinition } from "@/features/custom-fields/types";
import type { CatalogColumn, ColumnChoice } from "@/features/list-columns/columns";
import { ListTable } from "@/features/list-columns/components/list-table";
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
};

/** Companies as a table, with the columns the user chose. */
export function CompaniesTable({ orgId, companies, columns, catalog, fields, sort, sortHref }: Props) {
  return (
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
        <Link href={paths.company(orgId, company.id)} className="font-medium text-ink underline-offset-4 hover:underline">
          {company.name}
        </Link>
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
            return company.ownerName;
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
  );
}
