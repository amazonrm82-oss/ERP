import Link from "next/link";

import { SortableHeader } from "@/components/sortable-header";

import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/paths";
import type { Sort } from "@/lib/sort";

import { leadDisplayName, statusTone } from "../display";
import type { LeadListItem, LeadSortKey, LeadSourceOption, LeadStatusOption } from "../queries";

type Props = {
  orgId: string;
  leads: LeadListItem[];
  statuses: LeadStatusOption[];
  sources: LeadSourceOption[];
  // the current sort, and the address that sorts by a column (LST-02)
  sort: Sort<LeadSortKey>;
  sortHref: (key: LeadSortKey) => string;
};

const th = "px-4 py-2.5 text-start text-sm font-medium text-ink-soft whitespace-nowrap";
const td = "px-4 py-3 align-top";

/**
 * Leads as a table. On narrow screens the secondary columns are hidden and
 * the phone moves under the name, so each row stays readable at 360px.
 */
export function LeadsTable({ orgId, leads, statuses, sources, sort, sortHref }: Props) {
  const header = (key: LeadSortKey, label: string, className: string) => (
    <SortableHeader
      label={label}
      className={className}
      direction={sort.key === key ? (sort.ascending ? "ascending" : "descending") : null}
      href={sortHref(key)}
    />
  );
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const sourceById = new Map(sources.map((source) => [source.id, source.name]));

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-[0.9375rem]">
        <thead className="border-b border-line bg-canvas/60">
          <tr>
            {header("name", "שם", `${th} sm:min-w-52`)}
            {header("phone", "טלפון", `${th} hidden sm:table-cell`)}
            {header("email", "אימייל", `${th} hidden lg:table-cell`)}
            <th scope="col" className={th}>
              סטטוס
            </th>
            <th scope="col" className={`${th} hidden lg:table-cell`}>
              מקור
            </th>
            <th scope="col" className={`${th} hidden xl:table-cell`}>
              בעלים
            </th>
            {header("created", "נוצר", `${th} hidden md:table-cell`)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {leads.map((lead) => {
            const status = statusById.get(lead.statusId);
            return (
              <tr key={lead.id} className="hover:bg-canvas/50">
                <td className={td}>
                  <Link href={paths.lead(orgId, lead.id)} className="font-medium text-ink underline-offset-4 hover:underline">
                    {leadDisplayName(lead)}
                  </Link>
                  {lead.companyName ? <span className="block text-sm text-ink-soft">{lead.companyName}</span> : null}
                  {/* phones: the phone column is hidden, so the number moves here (unless it already is the name) */}
                  {lead.phone && (lead.fullName || lead.email) ? (
                    <span dir="ltr" className="block text-end text-sm text-ink-soft sm:hidden">
                      {lead.phone}
                    </span>
                  ) : null}
                </td>
                <td className={`${td} hidden whitespace-nowrap sm:table-cell`}>
                  {lead.phone ? <span dir="ltr">{lead.phone}</span> : null}
                </td>
                <td className={`${td} hidden lg:table-cell`}>
                  {lead.email ? (
                    // long addresses are cut with an ellipsis; the full address is in the tooltip and on the lead's page
                    <span dir="ltr" title={lead.email} className="block max-w-52 truncate text-end">
                      {lead.email}
                    </span>
                  ) : null}
                </td>
                <td className={td}>
                  <Badge tone={statusTone(status)}>{status?.name ?? "ללא סטטוס"}</Badge>
                </td>
                <td className={`${td} hidden whitespace-nowrap lg:table-cell`}>
                  {lead.sourceId ? sourceById.get(lead.sourceId) : null}
                </td>
                <td className={`${td} hidden whitespace-nowrap xl:table-cell`}>{lead.ownerName}</td>
                <td className={`${td} hidden whitespace-nowrap text-ink-soft md:table-cell`}>
                  <time dateTime={lead.createdAt}>{formatDate(lead.createdAt)}</time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
