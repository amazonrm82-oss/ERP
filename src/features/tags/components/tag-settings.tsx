"use client";

import { useActionState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createTagAction, deleteTagAction, renameTagAction } from "../actions";
import type { TagOption } from "../queries";
import { TAG_COLORS, tagTone } from "../types";

export function CreateTagForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(createTagAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="flex items-start gap-2" noValidate>
      <TextField
        label="שם התגית החדשה"
        hideLabel
        name="name"
        required
        maxLength={40}
        autoComplete="off"
        placeholder="תגית חדשה"
        controlSize="sm"
        className="min-w-0 flex-1"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
      />
      <SubmitButton size="sm" pendingText="מוסיפים…">
        הוספת תגית
      </SubmitButton>
    </form>
  );
}

export function TagList({ orgId, tags, editable }: { orgId: string; tags: TagOption[]; editable: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {tags.map((tag) => (
        <TagRow key={`${tag.id}-${tag.name}`} orgId={orgId} tag={tag} editable={editable} />
      ))}
    </ul>
  );
}

function TagRow({ orgId, tag, editable }: { orgId: string; tag: TagOption; editable: boolean }) {
  const [state, formAction] = useActionState<FormState, FormData>(renameTagAction.bind(null, orgId, tag.id), null);
  const failure = state && !state.ok ? state : null;
  if (!editable) {
    return (
      <li className="px-4 py-3 sm:px-5">
        <Badge tone={tagTone(tag.color)}>{tag.name}</Badge>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 sm:px-5">
      <form action={formAction} className="flex min-w-0 flex-1 items-start gap-2" noValidate>
        <TextField
          label="שם התגית"
          hideLabel
          name="name"
          required
          maxLength={40}
          autoComplete="off"
          controlSize="sm"
          className="min-w-0 flex-1"
          defaultValue={failure?.values?.name ?? tag.name}
          error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
        />
        <SelectField
          label={`צבע: ${tag.name}`}
          hideLabel
          name="color"
          controlSize="sm"
          className="w-28"
          defaultValue={tagTone(tag.color)}
          error={failure?.fieldErrors?.color}
        >
          {TAG_COLORS.map((color) => (
            <option key={color.value} value={color.value}>
              {color.label}
            </option>
          ))}
        </SelectField>
        <span aria-hidden="true" className="flex min-h-9 items-center">
          <Badge tone={tagTone(failure?.values?.color ?? tag.color)}>{tag.name}</Badge>
        </span>
        <SubmitButton size="sm" variant="secondary">
          שמירה
          <span className="sr-only">: {tag.name}</span>
        </SubmitButton>
      </form>
      <ActionButton
        action={deleteTagAction.bind(null, orgId, tag.id)}
        pendingText="מוחקים…"
        variant="danger-ghost"
        confirm={`למחוק את התגית "${tag.name}"? היא תוסר מכל הרשומות.`}
      >
        מחיקה
      </ActionButton>
    </li>
  );
}
