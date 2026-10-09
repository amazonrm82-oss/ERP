"use client";

import { createContext, useContext, useId, useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/field";

import { RECORD_TYPES } from "@/lib/record-types";

import { bulkAction, undoBulkAction, type BulkChange, type BulkObject, type BulkUndo } from "../actions";

type Option = { value: string; label: string; needsReason?: boolean };

type Selection = {
  picked: Set<string>;
  toggle: (id: string, on: boolean) => void;
};
const SelectionContext = createContext<Selection | null>(null);

/** The checkbox at the start of a row; nothing when the list has no bulk actions. */
export function RowCheck({ id, label }: { id: string; label: string }) {
  const selection = useContext(SelectionContext);
  if (!selection) return null;
  return (
    <input
      type="checkbox"
      aria-label={`בחירה: ${label}`}
      checked={selection.picked.has(id)}
      onChange={(e) => selection.toggle(id, e.target.checked)}
      className="mt-1 size-4 shrink-0 accent-accent"
    />
  );
}

type Props = {
  orgId: string;
  object: BulkObject;
  // the rows on this page, in order
  ids: string[];
  owners: Option[] | null;
  // a lead's statuses, or a task's (open, done, cancelled)
  statuses: Option[] | null;
  // the deals table: the stages of the pipeline on screen
  stages?: Option[] | null;
  tags: Option[];
  canTrash: boolean;
  // the list's export route, for "export the picked rows" (LST-08); null when the user may not export
  exportPath: string | null;
  // false: the list is shown as is, without checkboxes (a viewer)
  enabled: boolean;
  children: ReactNode;
};

// "export" is not a change: it downloads the picked rows through the list's export route
type Kind = BulkChange["kind"] | "export";
const NO_OWNER = "none";
const FORMATS: Option[] = [
  { value: "xlsx", label: "Excel" },
  { value: "csv", label: "CSV" },
];
const KIND_LABELS: Record<Kind, string> = {
  owner: "שינוי אחראי",
  status: "שינוי סטטוס",
  stage: "שינוי שלב",
  tag: "הוספת תגית",
  trash: "העברה לסל המחזור",
  export: "ייצוא הנבחרים",
};

/**
 * Picking rows in a list and acting on all of them at once (LST-07): the bar
 * above the table picks the whole page, counts what is picked, and runs one
 * action on it. Rows the user may not change are skipped and counted.
 */
export function BulkSelection({ orgId, object, ids, owners, statuses, stages = null, tags, canTrash, exportPath, enabled, children }: Props) {
  // a task has a "state" (מצב) rather than a status, and an assignee rather than an owner
  const labels: Record<Kind, string> =
    object === "task" ? { ...KIND_LABELS, status: "שינוי מצב", owner: "שינוי אחראי" } : KIND_LABELS;
  const barId = useId();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<Kind | "">("");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // FXU-06: asked in the page before it runs, and undoable after
  const [confirming, setConfirming] = useState(false);
  const [lastUndo, setLastUndo] = useState<BulkUndo | null>(null);
  const [pending, startTransition] = useTransition();

  // rows that left the page (another page, a filter, a refresh) drop out of the selection
  const current = new Set(ids);
  const shown = new Set([...picked].filter((id) => current.has(id)));
  const count = shown.size;
  const allPicked = ids.length > 0 && count === ids.length;

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const kinds = (Object.keys(KIND_LABELS) as Kind[]).filter(
    (k) =>
      (k !== "owner" || owners) &&
      (k !== "status" || statuses) &&
      (k !== "stage" || stages) &&
      (k !== "tag" || tags.length > 0) &&
      (k !== "trash" || canTrash) &&
      (k !== "export" || exportPath),
  );
  const options = kind === "owner" ? (owners ?? []) : kind === "status" ? (statuses ?? []) : kind === "stage" ? (stages ?? []) : kind === "tag" ? tags : kind === "export" ? FORMATS : [];
  const needsReason = kind === "status" && options.find((o) => o.value === value)?.needsReason;
  const ready = kind === "trash" || (kind !== "" && value !== "");

  // what the button says: the action, how many, and to what (FXU-06)
  const plural = RECORD_TYPES[object].plural;
  const feminine = object === "company" || object === "deal" || object === "task";
  const many = count === 1 ? `${RECORD_TYPES[object].singular} ${feminine ? "אחת" : "אחד"}` : `${count} ${plural}`;
  const chosen = value === NO_OWNER ? "ללא אחראי" : (options.find((o) => o.value === value)?.label ?? "");
  const actionText =
    kind === "owner"
      ? `העברת ${many} ל${chosen}`
      : kind === "status"
        ? `שינוי ${object === "task" ? "המצב" : "הסטטוס"} של ${many} ל"${chosen}"`
        : kind === "stage"
          ? `העברת ${many} לשלב "${chosen}"`
          : kind === "tag"
            ? `הוספת התגית "${chosen}" ל${count === 1 ? many : `-${many}`}`
            : kind === "trash"
              ? `העברת ${many} לסל המחזור`
              : kind === "export"
                ? `ייצוא ${many} לקובץ ${chosen}`
                : "";

  function run() {
    if (!kind) return;
    if (kind === "export") {
      if (!exportPath) return;
      // a download link, clicked: the page stays as it is
      const link = document.createElement("a");
      link.href = `${exportPath}?ids=${[...shown].join(",")}&format=${value}`;
      link.download = "";
      link.click();
      setNotice(count === 1 ? "הקובץ של הרשומה יורד." : `הקובץ של ${count} הרשומות יורד.`);
      return;
    }
    const change: BulkChange =
      kind === "owner"
        ? { kind, ownerId: value === NO_OWNER ? null : value }
        : kind === "status"
          ? { kind, statusId: value, reason }
          : kind === "stage"
            ? { kind, stageId: value }
            : kind === "tag"
              ? { kind, tagId: value }
              : { kind: "trash" };
    setConfirming(false);
    setError(null);
    setNotice(null);
    setLastUndo(null);
    startTransition(async () => {
      const result = await bulkAction(orgId, object, [...shown], change);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const { done, skipped, undo } = result.data!;
      setNotice(
        (done === 1 ? "רשומה אחת עודכנה." : `${done} רשומות עודכנו.`) +
          (skipped > 0 ? ` ${skipped === 1 ? "רשומה אחת דולגה" : `${skipped} דולגו`}: אין הרשאה, או שכבר לא קיימות.` : ""),
      );
      setLastUndo(undo.rows.length > 0 ? undo : null);
      setPicked(new Set());
      setKind("");
      setValue("");
      setReason("");
    });
  }

  function undoLast() {
    if (!lastUndo) return;
    const undo = lastUndo;
    setError(null);
    startTransition(async () => {
      const result = await undoBulkAction(orgId, object, undo);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setLastUndo(null);
      const back = result.data!.done;
      setNotice(back === undo.rows.length ? "הפעולה בוטלה." : `הפעולה בוטלה ב-${back} מתוך ${undo.rows.length}. השאר כבר השתנו מאז או שאין הרשאה.`);
    });
  }

  if (!enabled) return <>{children}</>;

  return (
    <SelectionContext.Provider value={{ picked: shown, toggle }}>
      <div
        id={barId}
        role="group"
        aria-label="פעולות על הנבחרים"
        className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2"
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allPicked}
            ref={(el) => {
              if (el) el.indeterminate = count > 0 && !allPicked;
            }}
            onChange={(e) => setPicked(e.target.checked ? new Set(ids) : new Set())}
            className="size-4 accent-accent"
          />
          <span>בחירת כל העמוד</span>
        </label>
        <span role="status" className="text-sm text-ink-soft">
          {count > 0 ? `נבחרו ${count}` : ""}
        </span>
        {count > 0 ? (
          <>
            <div className="w-44">
              <Select
                aria-label="פעולה"
                controlSize="sm"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as Kind | "");
                  setValue("");
                  setError(null);
                  setConfirming(false);
                }}
              >
                <option value="">בחירת פעולה</option>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {labels[k]}
                  </option>
                ))}
              </Select>
            </div>
            {kind === "owner" || kind === "status" || kind === "stage" || kind === "tag" || kind === "export" ? (
              <div className="w-44">
                <Select
                  aria-label={
                    kind === "owner"
                      ? object === "task"
                        ? "אחראי חדש"
                        : "אחראי חדש"
                      : kind === "status"
                        ? object === "task"
                          ? "מצב חדש"
                          : "סטטוס חדש"
                        : kind === "stage"
                          ? "שלב חדש"
                          : kind === "export"
                            ? "סוג הקובץ"
                            : "תגית"
                  }
                  controlSize="sm"
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setConfirming(false);
                  }}
                >
                  <option value="">בחירה</option>
                  {kind === "owner" ? <option value={NO_OWNER}>ללא אחראי</option> : null}
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            {needsReason ? (
              <div className="w-56">
                <Input
                  aria-label="סיבה"
                  placeholder="למה לא רלוונטי?"
                  controlSize="sm"
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            ) : null}
            {kind && !confirming ? (
              <Button
                size="sm"
                variant={kind === "trash" ? "danger" : "primary"}
                disabled={pending || !ready}
                aria-busy={pending || undefined}
                // export changes nothing, so it runs at once; every change is asked first
                onClick={() => (kind === "export" ? run() : setConfirming(true))}
              >
                {pending ? "מעדכן…" : actionText || `ביצוע על ${count}`}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPicked(new Set())}>
              ניקוי הבחירה
            </Button>
          </>
        ) : null}
        {confirming && kind && kind !== "export" ? (
          <div role="group" aria-label="אישור הפעולה" className="flex w-full flex-wrap items-center gap-2 rounded-md bg-canvas px-3 py-2">
            <span className="text-md">
              {actionText}?{kind === "trash" ? " אפשר לשחזר מסל המחזור במשך 30 יום." : " אפשר לבטל מיד אחרי."}
            </span>
            <Button size="sm" variant={kind === "trash" ? "danger" : "primary"} onClick={run} loading={pending}>
              כן, לבצע
            </Button>
            <Button size="sm" variant="secondary" autoFocus onClick={() => setConfirming(false)} disabled={pending}>
              לא עכשיו
            </Button>
          </div>
        ) : null}
        <FormError message={error} className="w-full" />
        {notice ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            <FormNotice message={notice} className="flex-1" />
            {lastUndo ? (
              <Button size="sm" variant="secondary" onClick={undoLast} loading={pending}>
                ביטול
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {children}
    </SelectionContext.Provider>
  );
}
