"use client";

import { createContext, useContext, useId, useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/field";

import { bulkAction, type BulkChange, type BulkObject } from "../actions";

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
  statuses: Option[] | null;
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
  owner: "שינוי בעלים",
  status: "שינוי סטטוס",
  tag: "הוספת תגית",
  trash: "העברה לסל המחזור",
  export: "ייצוא הנבחרים",
};

/**
 * Picking rows in a list and acting on all of them at once (LST-07): the bar
 * above the table picks the whole page, counts what is picked, and runs one
 * action on it. Rows the user may not change are skipped and counted.
 */
export function BulkSelection({ orgId, object, ids, owners, statuses, tags, canTrash, exportPath, enabled, children }: Props) {
  const barId = useId();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<Kind | "">("");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
      (k !== "tag" || tags.length > 0) &&
      (k !== "trash" || canTrash) &&
      (k !== "export" || exportPath),
  );
  const options = kind === "owner" ? (owners ?? []) : kind === "status" ? (statuses ?? []) : kind === "tag" ? tags : kind === "export" ? FORMATS : [];
  const needsReason = kind === "status" && options.find((o) => o.value === value)?.needsReason;
  const ready = kind === "trash" || (kind !== "" && value !== "");

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
          : kind === "tag"
            ? { kind, tagId: value }
            : { kind: "trash" };
    if (kind === "trash" && !window.confirm(`להעביר ${count} רשומות לסל המחזור? אפשר לשחזר משם במשך 30 יום.`)) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkAction(orgId, object, [...shown], change);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const { done, skipped } = result.data!;
      setNotice(
        (done === 1 ? "רשומה אחת עודכנה." : `${done} רשומות עודכנו.`) +
          (skipped > 0 ? ` ${skipped === 1 ? "רשומה אחת דולגה" : `${skipped} דולגו`}: אין הרשאה, או שכבר לא קיימות.` : ""),
      );
      setPicked(new Set());
      setKind("");
      setValue("");
      setReason("");
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
                }}
              >
                <option value="">בחירת פעולה</option>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </div>
            {kind === "owner" || kind === "status" || kind === "tag" || kind === "export" ? (
              <div className="w-44">
                <Select
                  aria-label={kind === "owner" ? "בעלים חדש" : kind === "status" ? "סטטוס חדש" : kind === "export" ? "סוג הקובץ" : "תגית"}
                  controlSize="sm"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                >
                  <option value="">בחירה</option>
                  {kind === "owner" ? <option value={NO_OWNER}>ללא בעלים</option> : null}
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
            {kind ? (
              <Button size="sm" variant={kind === "trash" ? "danger" : "primary"} disabled={pending || !ready} aria-busy={pending || undefined} onClick={run}>
                {pending ? "מעדכן…" : `ביצוע על ${count}`}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPicked(new Set())}>
              ניקוי הבחירה
            </Button>
          </>
        ) : null}
        <FormError message={error} className="w-full" />
        <FormNotice message={notice} className="w-full" />
      </div>
      {children}
    </SelectionContext.Provider>
  );
}
