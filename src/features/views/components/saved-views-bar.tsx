"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { ActionButton } from "@/components/action-button";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { cn } from "@/lib/cn";

import { deleteViewAction, saveViewAction } from "../actions";
import { filtersQuery, VIEW_FILTER_KEYS, type ViewFilters, type ViewObject } from "../types";

export type ViewChip = { id: string; name: string; shared: boolean; deletable: boolean; filters: ViewFilters };

type Props = {
  orgId: string;
  objectType: ViewObject;
  listPath: string;
  views: ViewChip[];
  current: ViewFilters;
  canSave: boolean;
  canShare: boolean;
};

/** Saved filter sets of a list, as links, plus "save the current filters". */
export function SavedViewsBar({ orgId, objectType, listPath, views, current, canSave, canShare }: Props) {
  const [saving, setSaving] = useState(false);
  const currentQuery = filtersQuery(current);
  const hasFilters = currentQuery !== "";
  const alreadySaved = views.some((view) => filtersQuery(view.filters) === currentQuery);

  if (views.length === 0 && !(canSave && hasFilters)) {
    return null;
  }

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {views.length > 0 ? <span className="text-sm text-ink-soft">תצוגות שמורות:</span> : null}
        {views.map((view) => {
          const active = filtersQuery(view.filters) === currentQuery && hasFilters;
          return (
            <span key={view.id} className="inline-flex items-center gap-1">
              <Link
                href={`${listPath}${filtersQuery(view.filters)}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm",
                  active ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line bg-surface hover:bg-canvas",
                )}
              >
                {view.name}
                {view.shared ? <span className="ms-1.5 text-xs text-ink-soft">(לכולם)</span> : null}
              </Link>
              {view.deletable ? (
                <ActionButton
                  action={deleteViewAction.bind(null, orgId, objectType, view.id)}
                  pendingText="…"
                  variant="ghost"
                  confirm={`למחוק את התצוגה "${view.name}"?`}
                  srLabel={view.name}
                >
                  <span aria-hidden="true">×</span>
                  <span className="sr-only">מחיקת תצוגה</span>
                </ActionButton>
              ) : null}
            </span>
          );
        })}
        {canSave && hasFilters && !alreadySaved && !saving ? (
          <Button variant="ghost" size="sm" onClick={() => setSaving(true)}>
            שמירת הסינון כתצוגה
          </Button>
        ) : null}
      </div>
      {saving ? (
        <SaveViewForm orgId={orgId} objectType={objectType} current={current} canShare={canShare} onDone={() => setSaving(false)} />
      ) : null}
    </div>
  );
}

type FormProps = { orgId: string; objectType: ViewObject; current: ViewFilters; canShare: boolean; onDone: () => void };

function SaveViewForm({ orgId, objectType, current, canShare, onDone }: FormProps) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveViewAction(orgId, objectType, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;

  return (
    <form action={formAction} className="flex flex-wrap items-start gap-2 rounded-md border border-line bg-surface p-3" noValidate>
      {VIEW_FILTER_KEYS.map((key) => (current[key] ? <input key={key} type="hidden" name={key} value={current[key]} /> : null))}
      <TextField
        label="שם התצוגה"
        name="name"
        required
        maxLength={80}
        autoComplete="off"
        controlSize="sm"
        className="min-w-0 flex-[1_1_12rem]"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name}
      />
      {canShare ? (
        <SelectField label="למי" name="scope" controlSize="sm" defaultValue={failure?.values?.scope ?? "private"} className="flex-[0_1_10rem]">
          <option value="private">רק לי</option>
          <option value="org">לכל העסק</option>
        </SelectField>
      ) : (
        <input type="hidden" name="scope" value="private" />
      )}
      <div className="flex gap-2 pt-6.5">
        <SubmitButton size="sm">שמירה</SubmitButton>
        <Button variant="ghost" size="sm" onClick={onDone}>
          ביטול
        </Button>
      </div>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} className="basis-full" />
    </form>
  );
}
