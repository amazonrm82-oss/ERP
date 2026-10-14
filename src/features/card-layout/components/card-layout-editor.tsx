"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { ReorderButtons } from "@/components/ui/reorder-buttons";

import { resetCardLayoutAction, saveCardLayoutAction } from "../actions";
import {
  CARD_LAYOUT_MAX_FIELDS,
  CARD_LAYOUT_MAX_GROUPS,
  CARD_LAYOUT_TITLE_MAX,
  layoutProblem,
  MORE_FIELDS_TITLE,
  NEW_GROUP_TITLE,
  type CardLayoutGroup,
  type CardLayoutType,
  type CatalogField,
} from "../layout";

type Props = {
  orgId: string;
  type: CardLayoutType;
  // the groups to start from (the saved layout, or the default one)
  initial: CardLayoutGroup[];
  catalog: CatalogField[];
  editable: boolean;
};

type EditGroup = CardLayoutGroup & { id: number };

const NO_GROUP = "none";

// where focus goes after a change: an element by id, else (first that is enabled) one of the
// named buttons inside it, else the element itself (rows and groups carry tabIndex -1)
type FocusRequest = { id: string; labels?: string[]; within?: string };

const upLabel = (name: string) => `להזיז למעלה: ${name}`;
const downLabel = (name: string) => `להזיז למטה: ${name}`;

/** A choice of group plus an explicit button, so browsing the list never moves anything. */
function MoveControl({
  label,
  buttonLabel,
  placeholder,
  options,
  onMove,
}: {
  label: string;
  buttonLabel: string;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  onMove: (to: string) => void;
}) {
  const [target, setTarget] = useState("");
  const valid = options.some((option) => option.value === target);
  return (
    <span className="flex items-end gap-1">
      <SelectField label={label} hideLabel controlSize="sm" className="w-36 shrink-0" value={valid ? target : ""} onChange={(event) => setTarget(event.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <Button variant="secondary" size="sm" disabled={!valid} aria-label={`${buttonLabel}: ${label}`} onClick={() => onMove(target)}>
        {buttonLabel}
      </Button>
    </span>
  );
}

function move<T>(list: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** FLD-08: arrange the details card of one record type into groups (owners and admins). */
export function CardLayoutEditor({ orgId, type, initial, catalog, editable }: Props) {
  const router = useRouter();
  const known = useMemo(() => new Map(catalog.map((field) => [field.key, field])), [catalog]);
  const [groups, setGroups] = useState<EditGroup[]>(() =>
    initial.map((group, index) => ({ ...group, id: index, fields: group.fields.filter((key) => known.has(key)) })),
  );
  const [nextId, setNextId] = useState(initial.length);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const focusRequest = useRef<FocusRequest | null>(null);
  const rowId = (key: string) => `layout-${type}-field-${key}`;
  const groupId = (id: number) => `layout-${type}-group-box-${id}`;
  const unplacedId = `layout-${type}-unplaced-box`;

  // after a move the moved item keeps focus (M2): its move button when still enabled, else the item
  useEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    const element = document.getElementById(request.id);
    if (!element) return;
    const scope = request.within ? element.querySelector<HTMLElement>(request.within) ?? element : element;
    const buttons = [...scope.querySelectorAll<HTMLButtonElement>("button")];
    for (const label of request.labels ?? []) {
      const button = buttons.find((b) => b.getAttribute("aria-label") === label && !b.disabled);
      if (button) {
        button.focus();
        return;
      }
    }
    element.focus();
  }, [groups]);

  const placed = new Set(groups.flatMap((group) => group.fields));
  const unplaced = catalog.filter((field) => !placed.has(field.key));
  const problem = layoutProblem(groups);
  const labelOf = (key: string) => known.get(key)?.label ?? key;
  const groupName = (group: EditGroup, index: number) => group.title.trim() || `קבוצה ${index + 1}`;

  function change(update: (current: EditGroup[]) => EditGroup[]) {
    setMessage(null);
    setGroups(update);
  }

  function moveField(key: string, to: string) {
    focusRequest.current = { id: rowId(key) };
    change((current) =>
      current.map((group) => {
        const without = group.fields.filter((k) => k !== key);
        return String(group.id) === to ? { ...group, fields: [...without, key] } : { ...group, fields: without };
      }),
    );
  }

  function addGroup() {
    change((current) => [...current, { id: nextId, title: NEW_GROUP_TITLE, columns: 1, fields: [] }]);
    setNextId((id) => id + 1);
  }

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveCardLayoutAction(
        orgId,
        type,
        groups.map(({ title, columns, fields }) => ({ title, columns, fields })),
      );
      if (!result.ok) {
        setMessage({ ok: false, text: result.message });
        return;
      }
      setMessage({ ok: true, text: result.message ?? "התצוגה נשמרה." });
      router.refresh();
    });
  }

  const moveOptions = (currentGroup: number | null) => [
    ...groups.flatMap((group, index) => (group.id === currentGroup ? [] : [{ value: String(group.id), label: groupName(group, index) }])),
    ...(currentGroup !== null ? [{ value: NO_GROUP, label: "בלי קבוצה" }] : []),
  ];

  return (
    <div className="space-y-4">
      {groups.map((group, index) => {
        const name = groupName(group, index);
        const titleId = `layout-${type}-group-${group.id}`;
        return (
          <div key={group.id} id={groupId(group.id)} tabIndex={-1} role="group" aria-labelledby={titleId}>
            <Card aria-labelledby={titleId}>
              <CardHeader
                id={titleId}
                title={name}
                action={
                  editable ? (
                    <span className="flex items-center gap-1">
                      <span data-group-reorder>
                        <ReorderButtons
                          name={name}
                          first={index === 0}
                          last={index === groups.length - 1}
                          onMove={(direction) => {
                            focusRequest.current = {
                              id: groupId(group.id),
                              within: "[data-group-reorder]",
                              labels: direction === -1 ? [upLabel(name), downLabel(name)] : [downLabel(name), upLabel(name)],
                            };
                            change((current) => move(current, index, direction));
                          }}
                        />
                      </span>
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        aria-label={`הסרת הקבוצה ${name}`}
                        onClick={() => {
                          focusRequest.current = { id: unplacedId };
                          change((current) => current.filter((g) => g.id !== group.id));
                        }}
                      >
                        הסרה
                      </Button>
                    </span>
                  ) : null
                }
              />
              <CardBody className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
                  <TextField
                    label="כותרת הקבוצה"
                    value={group.title}
                    maxLength={CARD_LAYOUT_TITLE_MAX}
                    disabled={!editable}
                    error={group.title.trim() === "" ? "לכל קבוצה צריך כותרת." : undefined}
                    onChange={(event) => {
                      const title = event.target.value;
                      change((current) => current.map((g) => (g.id === group.id ? { ...g, title } : g)));
                    }}
                  />
                  <SelectField
                    label="טורים"
                    value={String(group.columns)}
                    disabled={!editable}
                    onChange={(event) => {
                      const columns = event.target.value === "2" ? 2 : 1;
                      change((current) => current.map((g) => (g.id === group.id ? { ...g, columns } : g)));
                    }}
                  >
                    <option value="1">טור אחד</option>
                    <option value="2">שני טורים</option>
                  </SelectField>
                </div>
                {group.fields.length === 0 ? (
                  <p className="text-sm text-ink-soft">אין עדיין שדות בקבוצה. מוסיפים מהרשימה &quot;שדות שלא בקבוצה&quot; שלמטה, או מעבירים מקבוצה אחרת.</p>
                ) : (
                  <ul className="divide-y divide-line rounded-md border border-line" aria-label={`השדות בקבוצה ${name}`}>
                    {group.fields.map((key, fieldIndex) => (
                      <li key={key} id={rowId(key)} tabIndex={-1} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <span className="min-w-0 flex-1 break-words text-md">
                          {labelOf(key)}
                          {known.get(key)?.custom ? <span className="text-sm text-ink-soft"> (שדה שהוספתם)</span> : null}
                        </span>
                        {editable ? (
                          <>
                            <ReorderButtons
                              name={labelOf(key)}
                              first={fieldIndex === 0}
                              last={fieldIndex === group.fields.length - 1}
                              onMove={(direction) => {
                                const fieldName = labelOf(key);
                                focusRequest.current = {
                                  id: rowId(key),
                                  labels: direction === -1 ? [upLabel(fieldName), downLabel(fieldName)] : [downLabel(fieldName), upLabel(fieldName)],
                                };
                                change((current) => current.map((g) => (g.id === group.id ? { ...g, fields: move(g.fields, fieldIndex, direction) } : g)));
                              }}
                            />
                            <MoveControl
                              label={`קבוצה חדשה לשדה ${labelOf(key)}`}
                              buttonLabel="העברה"
                              placeholder="לאן להעביר…"
                              options={moveOptions(group.id)}
                              onMove={(to) => moveField(key, to)}
                            />
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>
        );
      })}

      <div id={unplacedId} tabIndex={-1} role="group" aria-labelledby={`layout-${type}-unplaced`}>
        <Card aria-labelledby={`layout-${type}-unplaced`}>
          <CardHeader id={`layout-${type}-unplaced`} title="שדות שלא בקבוצה" />
          <CardBody className="space-y-3">
            <p className="text-sm text-ink-soft">
              שדה שלא בקבוצה לא נעלם: הוא מופיע בכרטיס בסוף, בקבוצה &quot;{MORE_FIELDS_TITLE}&quot;.
            </p>
            {unplaced.length === 0 ? (
              <p className="text-sm text-ink-soft">כל השדות נמצאים בקבוצות.</p>
            ) : (
              <ul className="divide-y divide-line rounded-md border border-line" aria-label="שדות שלא בקבוצה">
                {unplaced.map((field) => (
                  <li key={field.key} id={rowId(field.key)} tabIndex={-1} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 break-words text-md">
                      {field.label}
                      {field.custom ? <span className="text-sm text-ink-soft"> (שדה שהוספתם)</span> : null}
                    </span>
                    {editable && groups.length > 0 ? (
                      <MoveControl
                        label={`קבוצה לשדה ${field.label}`}
                        buttonLabel="הוספה"
                        placeholder="לאיזו קבוצה…"
                        options={moveOptions(null)}
                        onMove={(to) => moveField(field.key, to)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {editable ? (
        <div className="space-y-3">
          <FormError message={message && !message.ok ? message.text : problem} />
          <FormNotice message={message?.ok ? message.text : null} />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={addGroup} disabled={groups.length >= CARD_LAYOUT_MAX_GROUPS}>
              הוספת קבוצה
            </Button>
            <Button size="sm" onClick={save} loading={pending} disabled={problem !== null}>
              שמירה
            </Button>
            <ConfirmButton
              variant="secondary"
              title="לחזור לתצוגת ברירת המחדל?"
              description="כל השדות יחזרו לקבוצה אחת, בסדר הרגיל. הקבוצות שיצרתם יימחקו."
              confirmLabel="שחזור ברירת מחדל"
              action={resetCardLayoutAction.bind(null, orgId, type)}
              onDone={() => {
                setMessage(null);
                router.refresh();
              }}
            >
              שחזור ברירת מחדל
            </ConfirmButton>
          </div>
          <p className="text-sm text-ink-soft">
            עד {CARD_LAYOUT_MAX_GROUPS} קבוצות ועד {CARD_LAYOUT_MAX_FIELDS} שדות בקבוצות.
          </p>
        </div>
      ) : null}
    </div>
  );
}
