"use client";

import { useActionState } from "react";

import { ActionButton } from "@/components/action-button";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addUnitAction, deleteUnitAction, moveUnitAction, renameUnitAction } from "../list-actions";
import { UNIT_NAME_MAX, type ProductUnit } from "../lists";

/** The units of measure (PRD-04): rename, reorder and delete one that no product uses. */
export function UnitList({ orgId, units, editable }: { orgId: string; units: ProductUnit[]; editable: boolean }) {
  return (
    <ol className="divide-y divide-line">
      {units.map((unit, index) => (
        <UnitRow key={`${unit.id}-${unit.name}`} orgId={orgId} unit={unit} editable={editable} isFirst={index === 0} isLast={index === units.length - 1} />
      ))}
    </ol>
  );
}

function UnitRow({ orgId, unit, editable, isFirst, isLast }: { orgId: string; unit: ProductUnit; editable: boolean; isFirst: boolean; isLast: boolean }) {
  const [state, formAction] = useActionState<FormState, FormData>(renameUnitAction.bind(null, orgId, unit.id), null);
  const failure = state && !state.ok ? state : null;

  if (!editable) {
    return <li className="px-4 py-3 font-medium break-words sm:px-5">{unit.name}</li>;
  }

  return (
    <li className="space-y-2 px-4 py-3 sm:px-5">
      <form action={formAction} className="flex items-start gap-2" noValidate>
        <TextField
          label={`שם היחידה ${unit.name}`}
          hideLabel
          name="name"
          required
          maxLength={UNIT_NAME_MAX}
          autoComplete="off"
          controlSize="sm"
          className="min-w-0 flex-1"
          defaultValue={failure?.values?.name ?? unit.name}
          error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
        />
        <SubmitButton size="sm" variant="secondary">
          שמירה
          <span className="sr-only">: {unit.name}</span>
        </SubmitButton>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        <ActionButton action={moveUnitAction.bind(null, orgId, unit.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={unit.name} disabled={isFirst}>
          הזזה למעלה
        </ActionButton>
        <ActionButton action={moveUnitAction.bind(null, orgId, unit.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={unit.name} disabled={isLast}>
          הזזה למטה
        </ActionButton>
        <ActionButton
          action={deleteUnitAction.bind(null, orgId, unit.id)}
          pendingText="מוחקים…"
          variant="danger-ghost"
          srLabel={unit.name}
          confirm={`למחוק את יחידת המידה "${unit.name}"?`}
        >
          מחיקה
        </ActionButton>
      </div>
    </li>
  );
}

export function AddUnitForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addUnitAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="flex items-start gap-2" noValidate>
      <TextField
        label="יחידת מידה חדשה"
        hideLabel
        placeholder="יחידה חדשה, למשל: חבילה"
        name="name"
        required
        maxLength={UNIT_NAME_MAX}
        autoComplete="off"
        controlSize="sm"
        className="min-w-0 flex-1"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
      />
      <SubmitButton size="sm" pendingText="מוסיפים…">
        הוספת יחידה
      </SubmitButton>
    </form>
  );
}
