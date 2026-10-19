"use client";

import { useActionState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import {
  addActivityTypeAction,
  deleteActivityTypeAction,
  editActivityTypeAction,
  moveActivityTypeAction,
  setActivityTypeActiveAction,
} from "../actions";
import { ACTIVITY_BASES, ACTIVITY_TYPE_ICONS, ACTIVITY_TYPE_NAME_MAX, BASE_LABELS, ICON_LABELS, typeIcon, type ActivityTypeOption } from "../types";
import { TypeIcon } from "./type-icon";

function IconSelect({ name, defaultValue, label }: { name: string; defaultValue: string; label: string }) {
  return (
    <SelectField key={`icon-${defaultValue}`} label={label} name={name} defaultValue={defaultValue} controlSize="sm" className="sm:max-w-40">
      <option value="">לפי הסוג הבסיסי</option>
      {ACTIVITY_TYPE_ICONS.map((icon) => (
        <option key={icon} value={icon}>
          {ICON_LABELS[icon]}
        </option>
      ))}
    </SelectField>
  );
}

/** TASK-08: the business's activity and task types: rename, icon, hide, reorder and delete. */
export function ActivityTypeList({ orgId, types, editable }: { orgId: string; types: ActivityTypeOption[]; editable: boolean }) {
  return (
    <ol className="divide-y divide-line">
      {types.map((type, index) => (
        <TypeRow
          key={`${type.id}-${type.name}-${type.icon}-${type.isActive}`}
          orgId={orgId}
          type={type}
          editable={editable}
          isFirst={index === 0}
          isLast={index === types.length - 1}
        />
      ))}
    </ol>
  );
}

type RowProps = { orgId: string; type: ActivityTypeOption; editable: boolean; isFirst: boolean; isLast: boolean };

function TypeRow({ orgId, type, editable, isFirst, isLast }: RowProps) {
  const [state, formAction] = useActionState<FormState, FormData>(editActivityTypeAction.bind(null, orgId, type.id), null);
  const failure = state && !state.ok ? state : null;
  const kind = <span className="text-sm text-ink-soft">סוג בסיסי: {BASE_LABELS[type.baseType]}</span>;

  if (!editable) {
    return (
      <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
        <TypeIcon icon={typeIcon(type)} className="size-4 shrink-0 text-ink-soft" />
        <span className="min-w-0 break-words font-medium">{type.name}</span>
        {kind}
        {type.isActive ? null : <Badge>מוסתר</Badge>}
      </li>
    );
  }

  return (
    <li className="space-y-2 px-4 py-3 sm:px-5">
      <form action={formAction} className="flex flex-wrap items-start gap-2" noValidate>
        <TypeIcon icon={typeIcon(type)} className="mt-2.5 size-4 shrink-0 text-ink-soft" />
        <TextField
          label={`שם הסוג ${type.name}`}
          hideLabel
          name="name"
          required
          maxLength={ACTIVITY_TYPE_NAME_MAX}
          autoComplete="off"
          controlSize="sm"
          className="min-w-40 flex-1"
          defaultValue={failure?.values?.name ?? type.name}
          error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
        />
        <IconSelect name="icon" label={`הסמל של ${type.name}`} defaultValue={failure?.values?.icon ?? type.icon ?? ""} />
        <SubmitButton size="sm" variant="secondary">
          שמירה
          <span className="sr-only">: {type.name}</span>
        </SubmitButton>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        {kind}
        {type.isActive ? null : <Badge>מוסתר</Badge>}
        <ActionButton action={moveActivityTypeAction.bind(null, orgId, type.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={type.name} disabled={isFirst}>
          הזזה למעלה
        </ActionButton>
        <ActionButton action={moveActivityTypeAction.bind(null, orgId, type.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={type.name} disabled={isLast}>
          הזזה למטה
        </ActionButton>
        <ActionButton action={setActivityTypeActiveAction.bind(null, orgId, type.id, !type.isActive)} pendingText="מעדכנים…" variant="ghost" srLabel={type.name}>
          {type.isActive ? "הסתרה" : "הצגה"}
        </ActionButton>
        <ActionButton
          action={deleteActivityTypeAction.bind(null, orgId, type.id)}
          pendingText="מוחקים…"
          variant="danger-ghost"
          srLabel={type.name}
          confirm={`למחוק את הסוג "${type.name}"? פעילויות ומשימות שסומנו בו יישארו, עם השם של הסוג הבסיסי.`}
        >
          מחיקה
        </ActionButton>
      </div>
    </li>
  );
}

export function AddActivityTypeForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addActivityTypeAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <div className="flex flex-wrap items-start gap-2">
        <TextField
          label="שם הסוג החדש"
          placeholder="למשל: ביקור, הדגמה"
          name="name"
          required
          maxLength={ACTIVITY_TYPE_NAME_MAX}
          autoComplete="off"
          controlSize="sm"
          className="min-w-40 flex-1"
          defaultValue={failure?.values?.name}
          error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
        />
        <SelectField
          key={`base-${failure?.values?.base_type ?? "meeting"}`}
          label="סוג בסיסי"
          name="base_type"
          defaultValue={failure?.values?.base_type ?? "meeting"}
          error={failure?.fieldErrors?.base_type}
          controlSize="sm"
          className="sm:max-w-40"
        >
          {ACTIVITY_BASES.map((base) => (
            <option key={base} value={base}>
              {BASE_LABELS[base]}
            </option>
          ))}
        </SelectField>
        <IconSelect name="icon" label="סמל" defaultValue={failure?.values?.icon ?? ""} />
      </div>
      <SubmitButton size="sm" pendingText="מוסיפים…">
        הוספת סוג
      </SubmitButton>
    </form>
  );
}
