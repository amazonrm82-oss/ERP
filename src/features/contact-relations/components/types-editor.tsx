"use client";

import { useActionState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addRelationTypeAction, deleteRelationTypeAction, moveRelationTypeAction, setRelationTypeActiveAction, updateRelationTypeAction } from "../actions";
import { CONTACT_RELATION_NAME_MAX, type ContactRelationType } from "../types";

/** CON-06: the business's types of relation between contacts: rename, hide, reorder and delete. */
export function RelationTypeList({ orgId, types, editable }: { orgId: string; types: ContactRelationType[]; editable: boolean }) {
  return (
    <ol className="divide-y divide-line">
      {types.map((type, index) => (
        <TypeRow
          key={`${type.id}-${type.name}-${type.reverseName ?? ""}-${type.isActive}`}
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

type RowProps = { orgId: string; type: ContactRelationType; editable: boolean; isFirst: boolean; isLast: boolean };

function TypeRow({ orgId, type, editable, isFirst, isLast }: RowProps) {
  const [state, formAction] = useActionState<FormState, FormData>(updateRelationTypeAction.bind(null, orgId, type.id), null);
  const failure = state && !state.ok ? state : null;
  const both = type.reverseName ? `${type.name} / ${type.reverseName}` : type.name;

  if (!editable) {
    return (
      <li className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <span className="min-w-0 break-words font-medium">{both}</span>
        {type.isActive ? null : <Badge>מוסתר</Badge>}
      </li>
    );
  }

  return (
    <li className="space-y-2 px-4 py-3 sm:px-5">
      <form action={formAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-start" noValidate>
        <TextField
          label={`הקשר מצד הראשון: ${type.name}`}
          hideLabel
          name="name"
          required
          maxLength={CONTACT_RELATION_NAME_MAX}
          autoComplete="off"
          controlSize="sm"
          defaultValue={failure?.values?.name ?? type.name}
          error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
        />
        <TextField
          label={`הקשר מצד השני: ${type.name}`}
          hideLabel
          name="reverse_name"
          placeholder="אותו דבר משני הצדדים"
          maxLength={CONTACT_RELATION_NAME_MAX}
          autoComplete="off"
          controlSize="sm"
          defaultValue={failure?.values?.reverse_name ?? type.reverseName ?? ""}
          error={failure?.fieldErrors?.reverse_name}
        />
        <SubmitButton size="sm" variant="secondary">
          שמירה
          <span className="sr-only">: {type.name}</span>
        </SubmitButton>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        {type.isActive ? null : <Badge>מוסתר</Badge>}
        {type.key === "referral" ? <Badge tone="accent">נספר בדוח ההפניות</Badge> : null}
        <ActionButton action={moveRelationTypeAction.bind(null, orgId, type.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={type.name} disabled={isFirst}>
          הזזה למעלה
        </ActionButton>
        <ActionButton action={moveRelationTypeAction.bind(null, orgId, type.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={type.name} disabled={isLast}>
          הזזה למטה
        </ActionButton>
        <ActionButton action={setRelationTypeActiveAction.bind(null, orgId, type.id, !type.isActive)} pendingText="מעדכנים…" variant="ghost" srLabel={type.name}>
          {type.isActive ? "הסתרה" : "הצגה"}
        </ActionButton>
        <ActionButton
          action={deleteRelationTypeAction.bind(null, orgId, type.id)}
          pendingText="מוחקים…"
          variant="danger-ghost"
          srLabel={type.name}
          confirm={`למחוק את סוג הקשר "${type.name}"? אפשר למחוק רק סוג שלא רשום אצל אף איש קשר.`}
        >
          מחיקה
        </ActionButton>
      </div>
    </li>
  );
}

export function AddRelationTypeForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addRelationTypeAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-start" noValidate>
      <TextField
        label="הקשר מצד הראשון"
        placeholder="למשל: סבא/סבתא של"
        name="name"
        required
        maxLength={CONTACT_RELATION_NAME_MAX}
        autoComplete="off"
        controlSize="sm"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
      />
      <TextField
        label="הקשר מצד השני (לא חובה)"
        placeholder="למשל: נכד/ה של"
        name="reverse_name"
        maxLength={CONTACT_RELATION_NAME_MAX}
        autoComplete="off"
        controlSize="sm"
        defaultValue={failure?.values?.reverse_name}
        error={failure?.fieldErrors?.reverse_name}
      />
      <SubmitButton size="sm" pendingText="מוסיפים…" className="sm:mt-7">
        הוספת סוג קשר
      </SubmitButton>
    </form>
  );
}
