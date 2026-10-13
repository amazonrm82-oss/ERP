"use client";

import { useState, useTransition, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { formatMoney, formatNumber } from "@/lib/format";

import { copyGoalsAction, saveGoalAction } from "../actions";
import { cellKey, peopleTotals, type GoalColumn, type GoalGridRow, type GoalValue } from "../grid";
import { goalMetric, targetText, type GoalMetric, type GoalPeriod } from "../metrics";

type Props = {
  orgId: string;
  metric: GoalMetric;
  period: GoalPeriod;
  columns: GoalColumn[];
  rows: GoalGridRow[];
  values: GoalValue[];
  // keys of the rows the person may change (the database decides either way)
  editable: string[];
  // the column the copy fills unless another is picked
  copyTarget: string;
  // the label of the period before each column ("ספטמבר", "רבעון 2", "2025")
  previousLabels: Record<string, string>;
  // shown by GoalsPanel, which outlives this grid: after a copy the page refreshes and the grid
  // starts over from the saved goals, but the "copied" message must stay on screen
  onMessage: (message: GoalsMessage) => void;
};

export type GoalsMessage = { tone: "error" | "ok"; text: string } | null;

type CellStatus = "saving" | "error";

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

/**
 * Goals as a table: one row per person, team and the business, one column per month
 * (or quarter, or year). Owners and admins (and managers, in their teams' rows) type a target into a cell; it is saved when the
 * cell loses focus or on Enter (which moves down a row). An empty cell is no goal.
 */
export function GoalsGrid({ orgId, metric, period, columns, rows, values, editable, copyTarget, previousLabels, onMessage: setMessage }: Props) {
  const definition = goalMetric(metric);
  const canEdit = new Set(editable);
  const anyEditable = canEdit.size > 0;
  const [saved, setSaved] = useState<Record<string, number>>(() => Object.fromEntries(values.map((v) => [cellKey(v, v.periodStart), v.target])));
  const [text, setText] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, CellStatus>>({});
  const [copyColumn, setCopyColumn] = useState(copyTarget);
  const [copying, startCopy] = useTransition();

  const shown = (key: string) => text[key] ?? targetText(definition.kind, saved[key]);
  const display = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : definition.kind === "money" ? formatMoney(value) : formatNumber(value);

  async function save(row: GoalGridRow, column: GoalColumn) {
    const key = cellKey(row, column.start);
    const typed = text[key];
    if (typed === undefined || typed.trim() === targetText(definition.kind, saved[key])) {
      setText((m) => without(m, key));
      return;
    }
    setStatus((s) => ({ ...s, [key]: "saving" }));
    const result = await saveGoalAction(orgId, {
      scope: row.scope,
      subjectId: row.subjectId,
      period,
      periodStart: column.start,
      metric,
      value: typed,
    });
    if (result.ok) {
      const target = result.data?.target ?? null;
      setSaved((m) => (target === null ? without(m, key) : { ...m, [key]: target }));
      setText((m) => without(m, key));
      setStatus((m) => without(m, key));
      setMessage({ tone: "ok", text: `נשמר: ${row.label}, ${column.label}.` });
    } else {
      setStatus((s) => ({ ...s, [key]: "error" }));
      setMessage({ tone: "error", text: `${row.label}, ${column.label}: ${result.message}` });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>, rowIndex: number, columnIndex: number, key: string) {
    if (event.key === "Escape") {
      setText((m) => without(m, key));
      setStatus((m) => without(m, key));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const next = rowIndex + (event.shiftKey ? -1 : 1);
      // the next row that can be typed into, skipping read-only ones
      let target: HTMLInputElement | null = null;
      for (let r = next; r >= 0 && r < rows.length && !target; r += event.shiftKey ? -1 : 1) {
        target = document.querySelector<HTMLInputElement>(`[data-goal-cell="${r}-${columnIndex}"]`);
      }
      if (target) {
        target.focus();
        target.select();
      } else {
        event.currentTarget.blur();
      }
    }
  }

  function copy() {
    startCopy(async () => {
      const result = await copyGoalsAction(
        orgId,
        { period, periodStart: copyColumn, metric },
        rows.filter((r) => canEdit.has(r.key)).map((r) => ({ scope: r.scope, subjectId: r.subjectId })),
      );
      if (!result.ok) {
        setMessage({ tone: "error", text: result.message });
        return;
      }
      const { added = 0, previous = 0 } = result.data ?? {};
      const label = columns.find((c) => c.start === copyColumn)?.label ?? "";
      setMessage({
        tone: "ok",
        text:
          previous === 0
            ? `אין יעדים ב${previousLabels[copyColumn]} להעתקה.`
            : added === 0
              ? `כל היעדים של ${label} כבר מוגדרים. לא שינינו אותם.`
              : `הועתקו ${formatNumber(added)} יעדים ל${label}. יעדים שכבר היו לא השתנו.`,
      });
    });
  }

  const userValues = Object.entries(saved).flatMap(([key, target]) => {
    const row = rows.find((r) => key.startsWith(`${r.key}@`));
    return row ? [{ scope: row.scope, subjectId: row.subjectId, periodStart: key.slice(key.indexOf("@") + 1), target }] : [];
  });
  const totals = peopleTotals(userValues, columns);
  const hasPeople = rows.some((r) => r.scope === "user");
  const unit = definition.kind === "money" ? " (₪)" : "";

  return (
    <div className="space-y-4">
      {anyEditable ? (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4">
          <div>
            <label htmlFor="goal-copy-target" className="mb-1.5 block text-sm font-medium text-ink">
              העתקה מהתקופה הקודמת אל
            </label>
            <Select id="goal-copy-target" value={copyColumn} onChange={(e) => setCopyColumn(e.target.value)} className="w-44">
              {columns.map((c) => (
                <option key={c.start} value={c.start}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" onClick={copy} loading={copying}>
            העתקה מ{previousLabels[copyColumn]}
          </Button>
          <p className="basis-full text-sm text-ink-soft">ממלא רק תאים ריקים. יעד שכבר הוגדר לא משתנה.</p>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-line bg-surface" role="region" aria-label="טבלת היעדים" tabIndex={0}>
        <table className="w-full min-w-max border-collapse text-md">
          <caption className="sr-only">
            {definition.label}
            {unit}: {anyEditable ? "הקלידו יעד בתא. Enter שומר ועובר לשורה הבאה, Escape מבטל." : "צפייה בלבד."}
          </caption>
          <thead>
            <tr className="border-b border-line text-sm text-ink-soft">
              <th scope="col" className="sticky start-0 z-10 bg-surface px-3 py-2.5 text-start font-medium">
                יעד של
              </th>
              {columns.map((c) => (
                <th key={c.start} scope="col" className="px-2 py-2.5 text-start font-medium">
                  <span aria-hidden="true" className="sm:hidden">
                    {c.short}
                  </span>
                  <span className="max-sm:sr-only">{c.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row, rowIndex) => (
              <tr key={row.key}>
                <th scope="row" className="sticky start-0 z-10 max-w-40 bg-surface px-3 py-1.5 text-start font-medium">
                  <span className="block truncate">{row.label}</span>
                  {row.hint ? <span className="block text-sm font-normal text-ink-soft">{row.hint}</span> : null}
                  {anyEditable && !canEdit.has(row.key) ? (
                    <span className="block text-sm font-normal text-ink-soft">את היעד הזה קובעים בעלים ומנהלי מערכת</span>
                  ) : null}
                </th>
                {columns.map((column, columnIndex) => {
                  const key = cellKey(row, column.start);
                  const state = status[key];
                  return (
                    <td key={column.start} className="px-1.5 py-1.5">
                      {canEdit.has(row.key) ? (
                        <input
                          type="text"
                          inputMode={definition.kind === "money" ? "decimal" : "numeric"}
                          dir="ltr"
                          data-goal-cell={`${rowIndex}-${columnIndex}`}
                          aria-label={`${row.label}, ${column.label}`}
                          aria-invalid={state === "error" || undefined}
                          aria-busy={state === "saving" || undefined}
                          value={shown(key)}
                          onChange={(e) => {
                            const value = e.target.value;
                            setText((t) => ({ ...t, [key]: value }));
                          }}
                          onBlur={() => void save(row, column)}
                          onKeyDown={(e) => onKeyDown(e, rowIndex, columnIndex, key)}
                          className={cn(
                            "block min-h-11 w-24 rounded-md border border-line-control bg-surface px-2 text-end tabular-nums text-ink",
                            "aria-invalid:border-danger",
                            state === "saving" && "text-ink-soft",
                          )}
                        />
                      ) : (
                        <span className="block w-24 px-2 text-end tabular-nums">{display(saved[key])}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {hasPeople ? (
              <tr className="bg-canvas text-ink-soft">
                <th scope="row" className="sticky start-0 z-10 bg-canvas px-3 py-2.5 text-start text-sm font-medium">
                  סכום יעדי חברי הצוות
                </th>
                {columns.map((c) => (
                  <td key={c.start} className="px-1.5 py-2.5">
                    <span className="block w-24 px-2 text-end text-sm tabular-nums">{display(totals[c.start])}</span>
                  </td>
                ))}
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
