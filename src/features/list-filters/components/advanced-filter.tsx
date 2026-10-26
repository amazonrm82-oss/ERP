"use client";

import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useEscapeToClose } from "@/components/ui/use-escape";
import { Input, Select } from "@/components/ui/field";

import { conditionCount, opLabel, OPS_BY_KIND, valueKind, type FilterCondition, type FilterField, type FilterGroup, type FilterTree } from "../model";

type Props = {
  fields: FilterField[];
  current: FilterTree | null;
  listPath: string;
  // the list's other URL settings (search, tag, sort, view), kept when the filter changes
  keep: Record<string, string>;
  // conditions the server could not use (a field was removed, a value is no longer valid)
  skipped: number;
};

const MATCH_LABELS = { all: "כל התנאים", any: "לפחות אחד" } as const;

/**
 * "Advanced filter" panel (LST-05): conditions on any field, in groups. Inside a
 * group the conditions are joined by "all" or "any", and so are the groups.
 * Applying it puts the filter in the URL, so it can be shared and saved in a view.
 */
export function AdvancedFilter({ fields, current, listPath, keep, skipped }: Props) {
  const router = useRouter();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEscapeToClose(open, useCallback(() => setOpen(false), []), triggerRef);
  const blankCondition = (): FilterCondition => ({ field: fields[0]?.key ?? "", op: OPS_BY_KIND[fields[0]?.kind ?? "text"][0], value: "" });
  const blankTree = (): FilterTree => ({ match: "all", groups: [{ match: "all", conditions: [blankCondition()] }] });
  const [tree, setTree] = useState<FilterTree>(current ?? blankTree());
  const count = conditionCount(current);

  const setGroup = (index: number, patch: Partial<FilterGroup>) =>
    setTree((t) => ({ ...t, groups: t.groups.map((g, i) => (i === index ? { ...g, ...patch } : g)) }));
  const setCondition = (gi: number, ci: number, patch: Partial<FilterCondition>) =>
    setGroup(gi, { conditions: tree.groups[gi].conditions.map((c, i) => (i === ci ? { ...c, ...patch } : c)) });

  function go(next: FilterTree | null) {
    const params = new URLSearchParams(keep);
    if (next) params.set("f", JSON.stringify(next));
    const query = params.toString();
    setOpen(false);
    router.push(query ? `${listPath}?${query}` : listPath);
  }

  const fieldOf = (key: string) => fields.find((field) => field.key === key);

  return (
    <div className="relative">
      <Button ref={triggerRef} variant={count > 0 ? "primary" : "secondary"} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
        {count > 0 ? `סינון מתקדם (${count})` : "סינון מתקדם"}
      </Button>
      {skipped > 0 && !open ? (
        <p role="status" className="mt-1 text-sm text-warning">
          {skipped === 1 ? "תנאי אחד לא הופעל: השדה או הערך כבר לא קיימים." : `${skipped} תנאים לא הופעלו: השדה או הערך כבר לא קיימים.`}
        </p>
      ) : null}
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label="סינון מתקדם"
          className="max-sm:fixed max-sm:inset-x-2 max-sm:top-16 max-sm:mt-0 max-sm:w-auto max-sm:max-h-[calc(100dvh-10rem)] max-sm:overflow-y-auto sm:absolute sm:end-0 z-20 mt-2 w-[min(40rem,calc(100vw-2rem))] space-y-3 rounded-lg border border-line bg-surface p-3 shadow-lg"
        >
          {tree.groups.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span>להציג רשומות שעונות על</span>
              <Select controlSize="sm" value={tree.match} onChange={(e) => setTree({ ...tree, match: e.target.value as "all" | "any" })} className="w-36">
                <option value="all">כל הקבוצות</option>
                <option value="any">לפחות קבוצה אחת</option>
              </Select>
            </label>
          ) : null}
          <div className="max-h-[60vh] space-y-3 overflow-y-auto">
            {tree.groups.map((group, gi) => (
              <fieldset key={gi} className="space-y-2 rounded-md border border-line p-2.5">
                <legend className="px-1 text-sm font-medium">קבוצה {gi + 1}</legend>
                {group.conditions.length > 1 ? (
                  <label className="flex items-center gap-2 text-sm">
                    <span>תנאים בקבוצה:</span>
                    <Select controlSize="sm" value={group.match} onChange={(e) => setGroup(gi, { match: e.target.value as "all" | "any" })} className="w-32">
                      {(["all", "any"] as const).map((m) => (
                        <option key={m} value={m}>
                          {MATCH_LABELS[m]}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : null}
                {group.conditions.map((condition, ci) => {
                  const field = fieldOf(condition.field);
                  const ops = field ? OPS_BY_KIND[field.kind] : [];
                  const needs = field ? valueKind(field.kind, condition.op as never) : "none";
                  const n = `${gi + 1}.${ci + 1}`;
                  return (
                    <div key={ci} className="flex flex-wrap items-center gap-2">
                      <div className="w-full sm:w-40">
                        <Select
                          aria-label={`שדה לתנאי ${n}`}
                          controlSize="sm"
                          value={condition.field}
                          onChange={(e) => {
                            const next = fieldOf(e.target.value);
                            setCondition(gi, ci, { field: e.target.value, op: OPS_BY_KIND[next?.kind ?? "text"][0], value: "" });
                          }}
                        >
                          {fields.map((f) => (
                            <option key={f.key} value={f.key}>
                              {f.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="w-[calc(50%-0.25rem)] sm:w-40">
                        <Select aria-label={`פעולה לתנאי ${n}`} controlSize="sm" value={condition.op} onChange={(e) => setCondition(gi, ci, { op: e.target.value })}>
                          {ops.map((op) => (
                            <option key={op} value={op}>
                              {field ? opLabel(field.kind, op) : op}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="min-w-0 flex-1">
                        {needs === "option" ? (
                          <Select aria-label={`ערך לתנאי ${n}`} controlSize="sm" value={condition.value ?? ""} onChange={(e) => setCondition(gi, ci, { value: e.target.value })}>
                            <option value="">בחירה</option>
                            {(field?.options ?? []).map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        ) : needs === "none" ? null : (
                          <Input
                            aria-label={needs === "days" ? `מספר ימים לתנאי ${n}` : `ערך לתנאי ${n}`}
                            controlSize="sm"
                            type={needs === "date" ? "date" : "text"}
                            inputMode={needs === "number" || needs === "days" ? "decimal" : undefined}
                            dir={needs === "number" || needs === "days" || needs === "date" ? "ltr" : undefined}
                            value={condition.value ?? ""}
                            maxLength={200}
                            onChange={(e) => setCondition(gi, ci, { value: e.target.value })}
                          />
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`הסרת תנאי ${n}`}
                        onClick={() =>
                          group.conditions.length > 1
                            ? setGroup(gi, { conditions: group.conditions.filter((_, i) => i !== ci) })
                            : setTree((t) => ({ ...t, groups: t.groups.length > 1 ? t.groups.filter((_, i) => i !== gi) : blankTree().groups }))
                        }
                      >
                        ×
                      </Button>
                    </div>
                  );
                })}
                {group.conditions.length < 10 ? (
                  <Button variant="ghost" size="sm" onClick={() => setGroup(gi, { conditions: [...group.conditions, blankCondition()] })}>
                    הוספת תנאי
                  </Button>
                ) : null}
              </fieldset>
            ))}
          </div>
          {tree.groups.length < 5 ? (
            <Button variant="secondary" size="sm" onClick={() => setTree((t) => ({ ...t, groups: [...t.groups, { match: "all", conditions: [blankCondition()] }] }))}>
              הוספת קבוצה
            </Button>
          ) : null}
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            <Button onClick={() => go(tree)}>החלת הסינון</Button>
            {current ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setTree(blankTree());
                  go(null);
                }}
              >
                ניקוי
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setOpen(false)}>
              סגירה
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
