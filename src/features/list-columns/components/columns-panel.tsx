"use client";

import { useCallback, useId, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useEscapeToClose } from "@/components/ui/use-escape";
import { FormError } from "@/components/ui/feedback";
import { Select } from "@/components/ui/field";

import { resetListColumnsAction, saveListColumnsAction } from "../actions";
import { WIDTH_LABELS, type CatalogColumn, type ColumnChoice, type ColumnWidth, type ListObject } from "../columns";

type Row = { key: string; label: string; visible: boolean; width: ColumnWidth };

type Props = { orgId: string; object: ListObject; catalog: CatalogColumn[]; columns: ColumnChoice[]; saved: boolean };

/**
 * "Columns" panel of a list: show or hide each column, move it up or down, and
 * pick its width. The shown columns come first, in their order; the name column
 * is always first in the table and is not listed here.
 */
export function ColumnsPanel({ orgId, object, catalog, columns, saved }: Props) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEscapeToClose(open, useCallback(() => setOpen(false), []), triggerRef);
  const initial = (): Row[] => {
    const label = new Map(catalog.map((column) => [column.key, column.label]));
    const shown = columns.map((choice) => ({ key: choice.key, label: label.get(choice.key) ?? choice.key, visible: true, width: choice.width }));
    const hidden = catalog
      .filter((column) => !columns.some((choice) => choice.key === column.key))
      .map((column) => ({ key: column.key, label: column.label, visible: false, width: "normal" as ColumnWidth }));
    return [...shown, ...hidden];
  };
  const [rows, setRows] = useState<Row[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const update = (index: number, patch: Partial<Row>) => setRows((list) => list.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const move = (index: number, by: -1 | 1) =>
    setRows((list) => {
      const next = [...list];
      [next[index], next[index + by]] = [next[index + by], next[index]];
      return next;
    });

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveListColumnsAction(
        orgId,
        object,
        rows.filter((row) => row.visible).map((row) => ({ key: row.key, width: row.width })),
      );
      if (result.ok) setOpen(false);
      else setError(result.message);
    });
  }

  function reset() {
    setError(null);
    startTransition(async () => {
      const result = await resetListColumnsAction(orgId, object);
      if (result.ok) setOpen(false);
      else setError(result.message);
    });
  }

  return (
    <div className="relative">
      <Button
        ref={triggerRef}
        variant="secondary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (!open) setRows(initial());
          setOpen(!open);
        }}
      >
        עמודות
      </Button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label="בחירת עמודות"
          className="max-sm:fixed max-sm:inset-x-2 max-sm:top-16 max-sm:mt-0 max-sm:w-auto max-sm:max-h-[calc(100dvh-10rem)] max-sm:overflow-y-auto sm:absolute sm:end-0 z-20 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-3 shadow-lg"
        >
          <p className="mb-2 text-sm text-ink-soft">השם תמיד מוצג ראשון. מסמנים מה להציג, ומסדרים בחצים.</p>
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
            {rows.map((row, index) => (
              <li key={row.key} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-canvas">
                <label className="flex min-w-0 flex-1 items-center gap-2 py-1">
                  <input type="checkbox" checked={row.visible} onChange={(e) => update(index, { visible: e.target.checked })} className="size-4 accent-accent" />
                  <span className="truncate">{row.label}</span>
                </label>
                <div className="w-24 shrink-0">
                  <Select
                    aria-label={`רוחב: ${row.label}`}
                    controlSize="sm"
                    value={row.width}
                    disabled={!row.visible}
                    onChange={(e) => update(index, { width: e.target.value as ColumnWidth })}
                  >
                    {(Object.keys(WIDTH_LABELS) as ColumnWidth[]).map((width) => (
                      <option key={width} value={width}>
                        {WIDTH_LABELS[width]}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button variant="ghost" size="sm" aria-label={`למעלה: ${row.label}`} disabled={index === 0} onClick={() => move(index, -1)}>
                  ↑
                </Button>
                <Button variant="ghost" size="sm" aria-label={`למטה: ${row.label}`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}>
                  ↓
                </Button>
              </li>
            ))}
          </ul>
          <FormError message={error} className="mt-2" />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={save} disabled={pending} aria-busy={pending || undefined}>
              {pending ? "שומרים…" : "שמירת העמודות"}
            </Button>
            {saved ? (
              <Button variant="ghost" onClick={reset} disabled={pending}>
                חזרה לברירת המחדל
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              סגירה
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
