"use client";

import { createContext, useContext, useId, useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Select } from "@/components/ui/field";
import { bulkTasksNotice, pickedTotal } from "@/features/deals/close-window";
import { BulkWonDialog, type BulkWonChoice, type BulkWonSetup } from "@/features/deals/components/bulk-won-dialog";
import { DisqualifyReasonField } from "@/features/disqualify-reasons/components/reason-field";

import { RECORD_TYPES } from "@/lib/record-types";

import { addToSegmentAction } from "@/features/segments/actions";

import { bulkAction, undoBulkAction, type BulkChange, type BulkObject, type BulkUndo } from "../actions";

// won: a deal stage of kind won, which opens the bulk close window (DEAL-04)
type Option = { value: string; label: string; needsReason?: boolean; won?: boolean };

type Selection = {
  picked: Set<string>;
  toggle: (id: string, on: boolean) => void;
};
const SelectionContext = createContext<Selection | null>(null);

/** The checkbox at the start of a row; nothing when the list has no bulk actions. */
export function RowCheck({ id, label }: { id: string; label: string }) {
  const selection = useContext(SelectionContext);
  if (!selection) return null;
  // FXA-09: a 36px touch target around the box (the negative margin keeps the row's layout)
  return (
    <label className="-m-2 inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-canvas">
      <input
        type="checkbox"
        aria-label={`בחירה: ${label}`}
        checked={selection.picked.has(id)}
        onChange={(e) => selection.toggle(id, e.target.checked)}
        className="size-5 accent-accent"
      />
    </label>
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
  // leads: the organization's active "not relevant" reasons (LEAD-03); empty: typed in freely.
  // deals: the active loss reasons, offered (not required) for a lost stage (DEAL-03)
  reasons?: string[];
  // deals: the organization's day and zone, and the amounts of the deals on the page, for the bulk close window (DEAL-04)
  wonWindow?: (BulkWonSetup & { amounts: Record<string, number> }) | null;
  // SEG-01: the static segments the picked leads or contacts can be added to; null for someone who may not
  segments?: Option[] | null;
  // LST-09: the product catalog's categories, for "change category"; null or missing: no such action
  categories?: Option[] | null;
  children: ReactNode;
};

// "export" is not a change: it downloads the picked rows through the list's export route.
// "segment" adds the rows to a static segment (SEG-01); it changes no record, so it has no undo here.
type Kind = BulkChange["kind"] | "export" | "segment";
const NO_OWNER = "none";
const NO_CATEGORY = "none";
const FORMATS: Option[] = [
  { value: "xlsx", label: "Excel" },
  { value: "csv", label: "CSV" },
];
const KIND_LABELS: Record<Kind, string> = {
  owner: "שינוי אחראי",
  status: "שינוי סטטוס",
  stage: "שינוי שלב",
  tag: "הוספת תגית",
  category: "שינוי קטגוריה",
  trash: "העברה לסל המחזור",
  segment: "הוספה לסגמנט",
  export: "ייצוא הנבחרים",
};

/**
 * Picking rows in a list and acting on all of them at once (LST-07): the bar
 * above the table picks the whole page, counts what is picked, and runs one
 * action on it. Rows the user may not change are skipped and counted.
 */
export function BulkSelection({
  orgId,
  object,
  ids,
  owners,
  statuses,
  stages = null,
  tags,
  canTrash,
  exportPath,
  enabled,
  reasons = [],
  wonWindow = null,
  segments = null,
  categories = null,
  children,
}: Props) {
  // a task and a product have a "state" (מצב) rather than a status
  const hasState = object === "task" || object === "product";
  const labels: Record<Kind, string> = hasState ? { ...KIND_LABELS, status: "שינוי מצב" } : KIND_LABELS;
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
  // DEAL-04: a move into a won stage asks for one close date first, in a window
  const [wonOpen, setWonOpen] = useState(false);
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
      (k !== "category" || categories !== null) &&
      (k !== "trash" || canTrash) &&
      (k !== "segment" || (segments !== null && segments.length > 0 && (object === "lead" || object === "contact"))) &&
      (k !== "export" || exportPath),
  );
  const options =
    kind === "owner"
      ? (owners ?? [])
      : kind === "status"
        ? (statuses ?? [])
        : kind === "stage"
          ? (stages ?? [])
          : kind === "tag"
            ? tags
            : kind === "category"
              ? (categories ?? [])
              : kind === "segment"
                ? (segments ?? [])
                : kind === "export"
                  ? FORMATS
                  : [];
  const needsReason = (kind === "status" || kind === "stage") && options.find((o) => o.value === value)?.needsReason;
  const toWon = kind === "stage" && wonWindow !== null && options.find((o) => o.value === value)?.won === true;
  // a deal's loss reason is optional; a lead's "not relevant" reason is not
  const ready = kind === "trash" || (kind !== "" && value !== "" && (!needsReason || kind === "stage" || reason.trim() !== ""));

  // what the button says: the action, how many, and to what (FXU-06)
  // the product catalog is not a record type (LST-09)
  const names =
    object === "product" ? { singular: "מוצר", plural: "מוצרים" } : object === "quote" ? { singular: "הצעה", plural: "הצעות" } : RECORD_TYPES[object];
  const plural = names.plural;
  const feminine = object === "company" || object === "deal" || object === "task" || object === "quote";
  const many = count === 1 ? `${names.singular} ${feminine ? "אחת" : "אחד"}` : `${count} ${plural}`;
  const chosen =
    kind === "owner" && value === NO_OWNER
      ? "ללא אחראי"
      : kind === "category" && value === NO_CATEGORY
        ? "ללא קטגוריה"
        : (options.find((o) => o.value === value)?.label ?? "");
  const actionText =
    kind === "owner"
      ? `העברת ${many} ל${chosen}`
      : kind === "status"
        ? `שינוי ${hasState ? "המצב" : "הסטטוס"} של ${many} ל"${chosen}"`
        : kind === "stage"
          ? `העברת ${many} לשלב "${chosen}"`
          : kind === "tag"
            ? `הוספת התגית "${chosen}" ל${count === 1 ? many : `-${many}`}`
            : kind === "category"
              ? `שינוי הקטגוריה של ${many} ל"${chosen}"`
              : kind === "trash"
              ? `העברת ${many} לסל המחזור`
              : kind === "segment"
                ? `הוספת ${many} לסגמנט "${chosen}"`
                : kind === "export"
                  ? `ייצוא ${many} לקובץ ${chosen}`
                  : "";

  function run(close?: BulkWonChoice) {
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
    if (kind === "segment") {
      if (object !== "lead" && object !== "contact") return;
      const segmentId = value;
      setError(null);
      setNotice(null);
      setLastUndo(null);
      startTransition(async () => {
        const result = await addToSegmentAction(orgId, object, segmentId, [...shown]);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setNotice(result.data!.message);
        setPicked(new Set());
        setKind("");
        setValue("");
      });
      return;
    }
    const change: BulkChange =
      kind === "owner"
        ? { kind, ownerId: value === NO_OWNER ? null : value }
        : kind === "status"
          ? { kind, statusId: value, reason }
          : kind === "stage"
            ? { kind, stageId: value, reason: needsReason ? reason : undefined, ...(close ? { close } : {}) }
            : kind === "tag"
              ? { kind, tagId: value }
              : kind === "category"
                ? { kind, categoryId: value === NO_CATEGORY ? null : value }
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
      const { done, skipped, undo, tasks, missing } = result.data!;
      const taskText = bulkTasksNotice(tasks);
      // FLD-09: records left out because a required field would stay empty, said apart from the rest
      const missingCount = missing?.count ?? 0;
      const otherSkipped = skipped - missingCount;
      setNotice(
        (done === 1 ? "רשומה אחת עודכנה." : `${done} רשומות עודכנו.`) +
          (missing && missingCount > 0 ? ` ${missingCount === 1 ? "רשומה אחת דולגה" : `${missingCount} דולגו`}: ${missing.reason}. ממלאים בכרטיס הרשומה ומנסים שוב.` : "") +
          (otherSkipped > 0 ? ` ${otherSkipped === 1 ? "רשומה אחת דולגה" : `${otherSkipped} דולגו`}: אין הרשאה, או שכבר לא קיימות.` : "") +
          (taskText ? ` ${taskText}` : ""),
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
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allPicked}
            ref={(el) => {
              if (el) el.indeterminate = count > 0 && !allPicked;
            }}
            onChange={(e) => setPicked(e.target.checked ? new Set(ids) : new Set())}
            className="size-5 accent-accent"
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
            {kind === "owner" || kind === "status" || kind === "stage" || kind === "tag" || kind === "category" || kind === "segment" || kind === "export" ? (
              <div className="w-44">
                <Select
                  aria-label={
                    kind === "owner"
                      ? object === "task"
                        ? "אחראי חדש"
                        : "אחראי חדש"
                      : kind === "status"
                        ? hasState
                          ? "מצב חדש"
                          : "סטטוס חדש"
                        : kind === "stage"
                          ? "שלב חדש"
                          : kind === "category"
                            ? "קטגוריה חדשה"
                          : kind === "export"
                            ? "סוג הקובץ"
                            : kind === "segment"
                              ? "סגמנט"
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
                  {kind === "category" ? <option value={NO_CATEGORY}>ללא קטגוריה</option> : null}
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
                <DisqualifyReasonField reasons={reasons} variant="bare" label="סיבה" controlSize="sm" value={reason} onChange={setReason} />
              </div>
            ) : null}
            {kind && !confirming ? (
              <Button
                size="sm"
                variant={kind === "trash" ? "danger" : "primary"}
                disabled={pending || !ready}
                aria-busy={pending || undefined}
                // export and "add to segment" change no record, so they run at once; a move into won asks in its window;
                // every other change is asked first
                onClick={() => (kind === "export" || kind === "segment" ? run() : toWon ? setWonOpen(true) : setConfirming(true))}
              >
                {pending ? "מעדכנים…" : actionText || `ביצוע על ${count}`}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPicked(new Set())}>
              ניקוי הבחירה
            </Button>
          </>
        ) : null}
        {confirming && kind && kind !== "export" && kind !== "segment" ? (
          <div role="group" aria-label="אישור הפעולה" className="flex w-full flex-wrap items-center gap-2 rounded-md bg-canvas px-3 py-2">
            <span className="text-md">
              {actionText}?{kind === "trash" ? " אפשר לשחזר מסל המחזור במשך 30 יום." : " אפשר לבטל מיד אחרי."}
            </span>
            <Button size="sm" variant={kind === "trash" ? "danger" : "primary"} onClick={() => run()} loading={pending}>
              כן, לבצע
            </Button>
            <Button size="sm" variant="secondary" autoFocus onClick={() => setConfirming(false)} disabled={pending}>
              לא עכשיו
            </Button>
          </div>
        ) : null}
        {wonWindow && toWon ? (
          <BulkWonDialog
            open={wonOpen}
            count={count}
            totalAgorot={pickedTotal(shown, wonWindow.amounts)}
            stageName={chosen}
            setup={wonWindow}
            onConfirm={(close) => {
              setWonOpen(false);
              run(close);
            }}
            onClose={() => setWonOpen(false)}
          />
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
