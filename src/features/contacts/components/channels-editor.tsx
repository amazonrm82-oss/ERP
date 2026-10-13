"use client";

import { useId, useState } from "react";

import { Button, IconButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { PlusIcon, TrashIcon } from "@/components/ui/icons";
import { ReorderButtons } from "@/components/ui/reorder-buttons";

import { channelTypeLabel, channelTypes, defaultType, MAX_EXTRA_CHANNELS, type ChannelDraft, type ChannelKind } from "../channels";

type Row = ChannelDraft & { key: number };

const TEXT: Record<ChannelKind, { legend: string; noun: string; add: string; field: string }> = {
  phone: { legend: "טלפונים", noun: "טלפון", add: "הוספת טלפון", field: "phones" },
  email: { legend: "אימיילים", noun: "אימייל", add: "הוספת אימייל", field: "emails" },
};

type Props = {
  kind: ChannelKind;
  initial: ChannelDraft[];
  error?: string;
};

/**
 * CON-01: the phones (or emails) of a contact: a type and a value each, one marked primary
 * (the call and WhatsApp buttons use it), in the order shown. Sends one hidden JSON field.
 */
export function ChannelsEditor({ kind, initial, error }: Props) {
  const text = TEXT[kind];
  const id = useId();
  const [rows, setRows] = useState<Row[]>(() => {
    const start = initial.length > 0 ? initial : [{ id: null, type: defaultType(kind), value: "", primary: true }];
    return start.map((draft, key) => ({ ...draft, key }));
  });
  // a new row's key: one past the largest in use
  const make = (list: Row[], draft: ChannelDraft): Row => ({ ...draft, key: list.reduce((max, r) => Math.max(max, r.key), -1) + 1 });
  // the first row is primary when none is marked
  const primaryKey = (rows.find((r) => r.primary) ?? rows[0])?.key;
  const max = MAX_EXTRA_CHANNELS + 1;

  const change = (key: number, patch: Partial<ChannelDraft>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const makePrimary = (key: number) => setRows((list) => list.map((r) => ({ ...r, primary: r.key === key })));
  const remove = (key: number) =>
    setRows((list) => {
      const left = list.filter((r) => r.key !== key);
      if (left.length === 0) return [make(list, { id: null, type: defaultType(kind), value: "", primary: true })];
      return left.some((r) => r.primary) ? left : left.map((r, i) => ({ ...r, primary: i === 0 }));
    });
  const move = (index: number, direction: -1 | 1) =>
    setRows((list) => {
      const target = index + direction;
      if (target < 0 || target >= list.length) return list;
      const copy = [...list];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy;
    });
  const add = () => setRows((list) => (list.length >= max ? list : [...list, make(list, { id: null, type: defaultType(kind), value: "", primary: false })]));

  const payload = JSON.stringify(rows.map((r) => ({ id: r.id, type: r.type, value: r.value, primary: r.key === primaryKey })));

  return (
    <fieldset className="min-w-0" aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="mb-1.5 text-sm font-medium text-ink">{text.legend}</legend>
      <input type="hidden" name={text.field} value={payload} />
      <ul className="space-y-3">
        {rows.map((row, index) => {
          const name = `${text.noun} ${index + 1}`;
          const isPrimary = row.key === primaryKey;
          return (
            <li key={row.key} className="rounded-md border border-line p-2">
              <div className="flex gap-2">
                <label htmlFor={`${id}-type-${row.key}`} className="sr-only">
                  {`סוג: ${name}`}
                </label>
                <Select
                  id={`${id}-type-${row.key}`}
                  value={row.type}
                  onChange={(e) => change(row.key, { type: e.target.value })}
                  className="w-24 shrink-0"
                >
                  {channelTypes(kind).map((type) => (
                    <option key={type} value={type}>
                      {channelTypeLabel(kind, type)}
                    </option>
                  ))}
                </Select>
                <label htmlFor={`${id}-value-${row.key}`} className="sr-only">
                  {name}
                </label>
                <Input
                  id={`${id}-value-${row.key}`}
                  type={kind === "phone" ? "tel" : "email"}
                  inputMode={kind === "phone" ? "tel" : "email"}
                  dir="ltr"
                  autoComplete="off"
                  maxLength={kind === "phone" ? 40 : 254}
                  value={row.value}
                  onChange={(e) => change(row.key, { value: e.target.value })}
                  aria-invalid={error ? true : undefined}
                  className="min-w-0 flex-1"
                />
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2">
                <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
                  <input
                    type="radio"
                    name={`${id}-primary`}
                    checked={isPrimary}
                    onChange={() => makePrimary(row.key)}
                    className="size-5 accent-[var(--color-accent)]"
                  />
                  {isPrimary ? "ראשי" : "להפוך לראשי"}
                  <span className="sr-only">{`: ${name}`}</span>
                </label>
                <span className="inline-flex">
                  <ReorderButtons name={name} onMove={(direction) => move(index, direction)} first={index === 0} last={index === rows.length - 1} />
                  <IconButton label={`הסרה: ${name}`} icon={<TrashIcon className="size-4.5" />} onClick={() => remove(row.key)} />
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {rows.length < max ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={add}>
          <PlusIcon className="size-4" />
          {text.add}
        </Button>
      ) : null}
    </fieldset>
  );
}
