"use client";

import { Button } from "@/components/ui/button";
import { Checkbox, Select, SelectField, TextField } from "@/components/ui/field";

import type { ConditionLink } from "../condition-match";
import {
  countLeaves,
  fieldConditionsFor,
  HOURS_CHOICES,
  isGroup,
  LINK_LABELS,
  LINKS_FOR,
  MAX_CONDITION_ITEMS,
  MAX_CONDITION_LEAVES,
  MAX_GROUP_ITEMS,
  TIME_CONDITIONS,
  WEEKDAYS,
  type ConditionItem,
  type ConditionLeaf,
} from "../conditions";
import { CONDITIONS, TASK_TYPES, type Entity } from "../definitions";
import type { Lookups } from "../queries";

/** AUT-05: the "אם" part of the builder: conditions joined by "וגם", "or" groups, linked records and time conditions. */
export function ConditionsEditor({
  entity,
  lookups,
  items,
  onChange,
}: {
  entity: Entity;
  lookups: Lookups;
  items: ConditionItem[];
  onChange: (items: ConditionItem[]) => void;
}) {
  const links = LINKS_FOR[entity];
  const roomForLeaf = countLeaves(items) < MAX_CONDITION_LEAVES;
  const firstLeaf = (): ConditionLeaf => {
    const option = fieldConditionsFor(entity)[0];
    return option ? { key: option.key, value: "" } : { key: "hours", value: "in" };
  };

  const setItem = (index: number, item: ConditionItem | null) =>
    onChange(item === null ? items.filter((_, i) => i !== index) : items.map((it, i) => (i === index ? item : it)));

  const leafEditor = (leaf: ConditionLeaf, label: string, change: (leaf: ConditionLeaf) => void, remove: () => void) => {
    const options = fieldConditionsFor(entity, leaf.on);
    const timeAllowed = !leaf.on;
    return (
      <div className="flex flex-wrap items-start gap-2">
        {links.length > 0 ? (
          <div className="w-full sm:w-40">
            <Select
              aria-label={`${label}: על איזו רשומה`}
              controlSize="sm"
              value={leaf.on ?? ""}
              onChange={(e) => {
                const on = (e.target.value || undefined) as ConditionLink | undefined;
                const first = fieldConditionsFor(entity, on)[0];
                change(first ? { key: first.key, value: "", ...(on ? { on } : {}) } : { key: "hours", value: "in" });
              }}
            >
              <option value="">הרשומה עצמה</option>
              {links.map((link) => (
                <option key={link} value={link}>
                  {LINK_LABELS[link]}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="w-full sm:w-52">
          <Select
            aria-label={label}
            controlSize="sm"
            value={leaf.key}
            onChange={(e) => {
              const key = e.target.value;
              change({ key, value: key === "hours" ? "in" : "", ...(leaf.on ? { on: leaf.on } : {}) });
            }}
          >
            {options.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
            {timeAllowed
              ? TIME_CONDITIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))
              : null}
          </Select>
        </div>
        <div className="min-w-40 flex-1">{valueEditor(leaf, label, (value) => change({ ...leaf, value }))}</div>
        <Button variant="ghost" size="sm" onClick={remove}>
          הסרה<span className="sr-only"> של {label}</span>
        </Button>
      </div>
    );
  };

  const valueEditor = (leaf: ConditionLeaf, label: string, set: (value: string) => void) => {
    const valueLabel = `ערך ל${label}`;
    if (leaf.key === "hours") {
      return (
        <SelectField label={valueLabel} hideLabel value={leaf.value} onChange={(e) => set(e.target.value)} controlSize="sm">
          {HOURS_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </SelectField>
      );
    }
    if (leaf.key === "weekday") {
      const picked = new Set(leaf.value.split(",").filter((d) => d !== ""));
      const toggle = (day: string, on: boolean) => {
        const next = new Set(picked);
        if (on) next.add(day);
        else next.delete(day);
        set([...next].sort().join(","));
      };
      return (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
          <legend className="sr-only">{valueLabel}</legend>
          {WEEKDAYS.map((name, day) => (
            <Checkbox key={day} label={name} checked={picked.has(String(day))} onChange={(e) => toggle(String(day), e.target.checked)} />
          ))}
        </fieldset>
      );
    }
    const option = CONDITIONS.find((c) => c.key === leaf.key);
    if (!option || option.input === "none") return null;
    if (option.input === "shekels") {
      return <TextField label={valueLabel} hideLabel value={leaf.value} onChange={(e) => set(e.target.value)} dir="ltr" inputMode="decimal" controlSize="sm" placeholder="10,000" />;
    }
    const list =
      option.input === "source"
        ? lookups.sources
        : option.input === "status"
          ? lookups.statuses
          : option.input === "tag"
            ? lookups.tags
            : option.input === "pipeline"
              ? lookups.pipelines
              : TASK_TYPES.map((t) => ({ id: t.value, name: t.label }));
    return (
      <SelectField label={valueLabel} hideLabel value={leaf.value} onChange={(e) => set(e.target.value)} controlSize="sm">
        <option value="">בחירה</option>
        {list.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </SelectField>
    );
  };

  return (
    <div className="space-y-3">
      {items.length === 0 ? <p className="text-md text-ink-soft">בלי תנאים: האוטומציה רצה בכל פעם.</p> : null}
      {items.map((item, index) => (
        <div key={index} className="space-y-3">
          {index > 0 ? (
            <p className="text-sm font-medium text-ink-soft" aria-hidden="true">
              וגם
            </p>
          ) : null}
          {isGroup(item) ? (
            <fieldset className="space-y-2 rounded-md border border-line p-3">
              <legend className="px-1 text-sm font-medium">אחד מאלה (תנאי {index + 1})</legend>
              {item.any.map((leaf, sub) => (
                <div key={sub} className="space-y-2">
                  {sub > 0 ? (
                    <p className="text-sm text-ink-soft" aria-hidden="true">
                      או
                    </p>
                  ) : null}
                  {leafEditor(
                    leaf,
                    `תנאי ${index + 1}, אפשרות ${sub + 1}`,
                    (next) => setItem(index, { any: item.any.map((l, i) => (i === sub ? next : l)) }),
                    () => {
                      const rest = item.any.filter((_, i) => i !== sub);
                      setItem(index, rest.length === 1 ? rest[0] : rest.length === 0 ? null : { any: rest });
                    },
                  )}
                </div>
              ))}
              {item.any.length < MAX_GROUP_ITEMS && roomForLeaf ? (
                <Button variant="secondary" size="sm" onClick={() => setItem(index, { any: [...item.any, firstLeaf()] })}>
                  עוד אפשרות (או)<span className="sr-only"> בתנאי {index + 1}</span>
                </Button>
              ) : null}
            </fieldset>
          ) : (
            <div className="space-y-2">
              {leafEditor(
                item,
                `תנאי ${index + 1}`,
                (next) => setItem(index, next),
                () => setItem(index, null),
              )}
              {roomForLeaf ? (
                <Button variant="ghost" size="sm" onClick={() => setItem(index, { any: [item, firstLeaf()] })}>
                  או…<span className="sr-only"> הוספת אפשרות לתנאי {index + 1}</span>
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ))}
      {items.length < MAX_CONDITION_ITEMS && roomForLeaf ? (
        <Button variant="secondary" size="sm" onClick={() => onChange([...items, firstLeaf()])}>
          הוספת תנאי
        </Button>
      ) : null}
    </div>
  );
}
