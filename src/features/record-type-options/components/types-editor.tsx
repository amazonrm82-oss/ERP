"use client";

import { useActionState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addTypeAction, deleteTypeAction, moveTypeAction, renameTypeAction, setTypeActiveAction } from "../actions";
import { TYPE_MAX, TYPE_TEXTS, type RecordType, type RecordTypeObject } from "../schema";

type ListProps = { orgId: string; object: RecordTypeObject; types: RecordType[]; editable: boolean };

/** The organization's contact or company types (CON-02): rename, hide, reorder and delete. */
export function TypeList({ orgId, object, types, editable }: ListProps) {
  return (
    <ol className="divide-y divide-line">
      {types.map((type, index) => (
        <TypeRow
          key={`${type.id}-${type.name}-${type.isActive}`}
          orgId={orgId}
          object={object}
          type={type}
          editable={editable}
          isFirst={index === 0}
          isLast={index === types.length - 1}
        />
      ))}
    </ol>
  );
}

type RowProps = { orgId: string; object: RecordTypeObject; type: RecordType; editable: boolean; isFirst: boolean; isLast: boolean };

function TypeRow({ orgId, object, type, editable, isFirst, isLast }: RowProps) {
  const [state, formAction] = useActionState<FormState, FormData>(renameTypeAction.bind(null, orgId, type.id), null);
  const failure = state && !state.ok ? state : null;

  if (!editable) {
    return (
      <li className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <span className="min-w-0 break-words font-medium">{type.name}</span>
        {type.isActive ? null : <Badge>מוסתר</Badge>}
      </li>
    );
  }

  return (
    <li className="space-y-2 px-4 py-3 sm:px-5">
      <form action={formAction} className="flex items-start gap-2" noValidate>
        <TextField
          label={`שם הסוג ${type.name}`}
          hideLabel
          name="name"
          required
          maxLength={TYPE_MAX}
          autoComplete="off"
          controlSize="sm"
          className="min-w-0 flex-1"
          defaultValue={failure?.values?.name ?? type.name}
          error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
        />
        <SubmitButton size="sm" variant="secondary">
          שמירה
          <span className="sr-only">: {type.name}</span>
        </SubmitButton>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        {type.isActive ? null : <Badge>מוסתר</Badge>}
        <ActionButton action={moveTypeAction.bind(null, orgId, object, type.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={type.name} disabled={isFirst}>
          הזזה למעלה
        </ActionButton>
        <ActionButton action={moveTypeAction.bind(null, orgId, object, type.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={type.name} disabled={isLast}>
          הזזה למטה
        </ActionButton>
        <ActionButton action={setTypeActiveAction.bind(null, orgId, type.id, !type.isActive)} pendingText="מעדכנים…" variant="ghost" srLabel={type.name}>
          {type.isActive ? "הסתרה" : "הצגה"}
        </ActionButton>
        <ActionButton
          action={deleteTypeAction.bind(null, orgId, type.id)}
          pendingText="מוחקים…"
          variant="danger-ghost"
          srLabel={type.name}
          confirm={`למחוק את הסוג "${type.name}"? רשומות מהסוג הזה יישארו בלי סוג. כדי שהן ישמרו אותו, אפשר להסתיר אותו במקום.`}
        >
          מחיקה
        </ActionButton>
      </div>
    </li>
  );
}

export function AddTypeForm({ orgId, object }: { orgId: string; object: RecordTypeObject }) {
  const [state, formAction] = useActionState<FormState, FormData>(addTypeAction.bind(null, orgId, object), null);
  const failure = state && !state.ok ? state : null;
  const texts = TYPE_TEXTS[object];
  return (
    <form action={formAction} className="flex items-start gap-2" noValidate>
      <TextField
        label={`${texts.title}: סוג חדש`}
        hideLabel
        placeholder={texts.placeholder}
        name="name"
        required
        maxLength={TYPE_MAX}
        autoComplete="off"
        controlSize="sm"
        className="min-w-0 flex-1"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
      />
      <SubmitButton size="sm" pendingText="מוסיפים…">
        {texts.add}
      </SubmitButton>
    </form>
  );
}
