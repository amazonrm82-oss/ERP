import Link from "next/link";

import { formatDate } from "@/lib/format";
import { paths } from "@/lib/paths";

import type { CompanyListItem } from "../queries";

const th = "px-4 py-2.5 text-start text-sm font-medium text-ink-soft whitespace-nowrap";
const td = "px-4 py-3 align-top";

/** Companies as a table; secondary columns drop out on narrow screens. */
export function CompaniesTable({ orgId, companies }: { orgId: string; companies: CompanyListItem[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-[0.9375rem]">
        <thead className="border-b border-line bg-canvas/60">
          <tr>
            <th scope="col" className={`${th} sm:min-w-52`}>
              שם
            </th>
            <th scope="col" className={`${th} hidden sm:table-cell`}>
              טלפון
            </th>
            <th scope="col" className={`${th} hidden md:table-cell`}>
              עיר
            </th>
            <th scope="col" className={`${th} hidden xl:table-cell`}>
              בעלים
            </th>
            <th scope="col" className={`${th} hidden lg:table-cell`}>
              נוצר
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {companies.map((company) => (
            <tr key={company.id} className="hover:bg-canvas/50">
              <td className={td}>
                <Link href={paths.company(orgId, company.id)} className="font-medium text-ink underline-offset-4 hover:underline">
                  {company.name}
                </Link>
                {company.city ? <span className="block text-sm text-ink-soft md:hidden">{company.city}</span> : null}
              </td>
              <td className={`${td} hidden whitespace-nowrap sm:table-cell`}>
                {company.phone ? <span dir="ltr">{company.phone}</span> : null}
              </td>
              <td className={`${td} hidden md:table-cell`}>{company.city}</td>
              <td className={`${td} hidden whitespace-nowrap xl:table-cell`}>{company.ownerName}</td>
              <td className={`${td} hidden whitespace-nowrap text-ink-soft lg:table-cell`}>
                <time dateTime={company.createdAt}>{formatDate(company.createdAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
