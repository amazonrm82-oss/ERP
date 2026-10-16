import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { SortableHeader } from "@/components/sortable-header";
import { displayCustomFields } from "@/features/custom-fields/values";
import type { CustomValues, FieldDefinition } from "@/features/custom-fields/types";
import { cn } from "@/lib/cn";
import type { Sort } from "@/lib/sort";

import { CUSTOM_PREFIX, WIDTH_CLASS, type CatalogColumn, type ColumnChoice } from "../columns";

const th = "px-4 py-2.5 text-start text-sm font-medium text-ink-soft whitespace-nowrap";
const td = "px-4 py-3 align-top";

type Props<R> = {
  rows: R[];
  rowKey: (row: R) => string;
  nameCell: (row: R) => ReactNode;
  columns: ColumnChoice[];
  catalog: CatalogColumn[];
  fields: FieldDefinition[];
  // a built-in column's content; custom fields are drawn here
  cell: (key: string, row: R) => ReactNode;
  customValues: (row: R) => CustomValues;
  // every column sorts: built-in ones through the list's sort columns, custom fields by their value
  sort: Sort<string>;
  sortHref: (key: string) => string;
  label: string;
  // the first column's sort key and title (tasks: "title", "כותרת")
  nameColumn?: { key: string; label: string };
};

/**
 * A list as a table with the user's columns (LST-03). The name column comes
 * first and stays in place while the rest scrolls sideways on a narrow screen,
 * so the page itself never scrolls sideways.
 */
export function ListTable<R>({
  rows,
  rowKey,
  nameCell,
  columns,
  catalog,
  fields,
  cell,
  customValues,
  sort,
  sortHref,
  label,
  nameColumn = { key: "name", label: "שם" },
}: Props<R>) {
  const labels = new Map(catalog.map((column) => [column.key, column.label]));
  const fieldByKey = new Map(fields.map((field) => [`${CUSTOM_PREFIX}${field.key}`, field]));
  const direction = (key: string) => (sort.key === key ? (sort.ascending ? "ascending" : "descending") : null);

  return (
    <div role="region" aria-label={label} tabIndex={0} className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-md">
        <thead className="border-b border-line bg-canvas">
          <tr>
            <SortableHeader label={nameColumn.label} direction={direction(nameColumn.key)} href={sortHref(nameColumn.key)} className={`${th} sticky start-0 z-10 min-w-44 bg-canvas sm:min-w-52`} />
            {columns.map((column) => (
              <SortableHeader
                key={column.key}
                label={labels.get(column.key) ?? column.key}
                direction={direction(column.key)}
                href={sortHref(column.key)}
                className={cn(th, WIDTH_CLASS[column.width])}
              />
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={rowKey(row)} className="group">
              <td className={`${td} sticky start-0 z-10 bg-surface group-hover:bg-canvas`}>{nameCell(row)}</td>
              {columns.map((column) => {
                const field = fieldByKey.get(column.key);
                if (field) {
                  const shown = displayCustomFields([field], customValues(row))[0];
                  return (
                    <td key={column.key} className={cn(td, "group-hover:bg-canvas/50")}>
                      {shown.text ? (
                        shown.href ? (
                          <a href={shown.href} target="_blank" rel="noopener noreferrer" dir="ltr" className="break-all text-accent-strong underline underline-offset-4">
                            {shown.text}
                          </a>
                        ) : shown.tone ? (
                          // FLD-06: a coloured status
                          <Badge tone={shown.tone}>{shown.text}</Badge>
                        ) : (
                          <span dir={shown.ltr ? "ltr" : undefined} className="break-words">
                            {shown.text}
                          </span>
                        )
                      ) : null}
                    </td>
                  );
                }
                return (
                  <td key={column.key} className={cn(td, "group-hover:bg-canvas/50")}>
                    {cell(column.key, row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
