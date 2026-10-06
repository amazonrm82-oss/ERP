"use client";

import { useActionState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import {
  addSourceAction,
  addStatusAction,
  deleteStatusAction,
  moveStatusAction,
  renameSourceAction,
  setDefaultStatusAction,
  setSourceActiveAction,
  updateStatusAction,
} from "../actions-leads";
import { STATUS_KIND_LABELS } from "../labels";
import type { SourceSetting, StatusSetting } from "../queries";
import { STATUS_KINDS } from "../schema";

const rowGrid = "grid grid-cols-2 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto]";

export function StatusList({ orgId, statuses, editable }: { orgId: string; statuses: StatusSetting[]; editable: boolean }) {
  return (
    <ol className="divide-y divide-line">
      {statuses.map((status, index) => (
        <StatusRow
          key={`${status.id}-${status.name}-${status.kind}`}
          orgId={orgId}
          status={status}
          editable={editable}
          isFirst={index === 0}
          isLast={index === statuses.length - 1}
        />
      ))}
    </ol>
  );
}

type StatusRowProps = { orgId: string; status: StatusSetting; editable: boolean; isFirst: boolean; isLast: boolean };

function StatusRow({ orgId, status, editable, isFirst, isLast }: StatusRowProps) {
  const [state, formAction] = useActionState<FormState, FormData>(updateStatusAction.bind(null, orgId, status.id), null);
  const failure = state && !state.ok ? state : null;
  const kind = failure?.values?.kind ?? status.kind;

  if (!editable) {
    return (
      <li className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <span className="font-medium">{status.name}</span>
        <span className="text-sm text-ink-soft">{STATUS_KIND_LABELS[status.kind]}</span>
      </li>
    );
  }

  return (
    <li className="space-y-2 px-4 py-3 sm:px-5">
      <form action={formAction} className={rowGrid} noValidate>
        <TextField
          label="שם הסטטוס"
          hideLabel
          name="name"
          required
          maxLength={60}
          autoComplete="off"
          controlSize="sm"
          className="col-span-2 sm:col-span-1"
          defaultValue={failure?.values?.name ?? status.name}
          error={failure?.fieldErrors?.name}
        />
        <SelectField key={`kind-${kind}`} label={`סוג הסטטוס ${status.name}`} hideLabel name="kind" controlSize="sm" defaultValue={kind}>
          {STATUS_KINDS.map((option) => (
            <option key={option} value={option}>
              {STATUS_KIND_LABELS[option]}
            </option>
          ))}
        </SelectField>
        <SubmitButton size="sm" variant="secondary">
          שמירה
          <span className="sr-only">: {status.name}</span>
        </SubmitButton>
      </form>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        {status.isDefault ? <Badge tone="accent">ברירת מחדל לליד חדש</Badge> : null}
        <span>{status.leadCount === 1 ? "ליד אחד" : `${status.leadCount} לידים`}</span>
        <ActionButton action={moveStatusAction.bind(null, orgId, status.id, "up")} pendingText="מזיז…" variant="ghost" srLabel={status.name} disabled={isFirst}>
          הזזה למעלה
        </ActionButton>
        <ActionButton action={moveStatusAction.bind(null, orgId, status.id, "down")} pendingText="מזיז…" variant="ghost" srLabel={status.name} disabled={isLast}>
          הזזה למטה
        </ActionButton>
        {status.isDefault || status.kind !== "open" ? null : (
          <ActionButton action={setDefaultStatusAction.bind(null, orgId, status.id)} pendingText="מעדכן…" variant="ghost" srLabel={status.name}>
            קביעה כברירת מחדל
          </ActionButton>
        )}
        {status.isDefault ? null : (
          <ActionButton
            action={deleteStatusAction.bind(null, orgId, status.id)}
            pendingText="מוחק…"
            variant="danger-ghost"
            confirm={`למחוק את הסטטוס "${status.name}"?`}
          >
            מחיקה
          </ActionButton>
        )}
      </div>
    </li>
  );
}

export function AddStatusForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addStatusAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-2" noValidate>
      <div className={rowGrid}>
        <TextField
          label="שם הסטטוס החדש"
          hideLabel
          placeholder="סטטוס חדש"
          name="name"
          required
          maxLength={60}
          autoComplete="off"
          controlSize="sm"
          className="col-span-2 sm:col-span-1"
          defaultValue={failure?.values?.name}
          error={failure?.fieldErrors?.name}
        />
        <SelectField label="סוג הסטטוס החדש" hideLabel name="kind" controlSize="sm" defaultValue={failure?.values?.kind ?? "open"}>
          {STATUS_KINDS.map((option) => (
            <option key={option} value={option}>
              {STATUS_KIND_LABELS[option]}
            </option>
          ))}
        </SelectField>
        <SubmitButton size="sm" pendingText="מוסיף…">
          הוספת סטטוס
        </SubmitButton>
      </div>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
    </form>
  );
}

export function SourceList({ orgId, sources, editable }: { orgId: string; sources: SourceSetting[]; editable: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {sources.map((source) => (
        <SourceRow key={`${source.id}-${source.name}-${source.isActive}`} orgId={orgId} source={source} editable={editable} />
      ))}
    </ul>
  );
}

function SourceRow({ orgId, source, editable }: { orgId: string; source: SourceSetting; editable: boolean }) {
  const [state, formAction] = useActionState<FormState, FormData>(renameSourceAction.bind(null, orgId, source.id), null);
  const failure = state && !state.ok ? state : null;

  if (!editable) {
    return (
      <li className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <span className="font-medium">{source.name}</span>
        {source.isActive ? null : <Badge>מוסתר</Badge>}
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 sm:px-5">
      <form action={formAction} className="flex min-w-0 flex-1 items-start gap-2" noValidate>
        <TextField
          label="שם המקור"
          hideLabel
          name="name"
          required
          maxLength={60}
          autoComplete="off"
          controlSize="sm"
          className="min-w-0 flex-1"
          defaultValue={failure?.values?.name ?? source.name}
          error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
        />
        <SubmitButton size="sm" variant="secondary">
          שמירה
          <span className="sr-only">: {source.name}</span>
        </SubmitButton>
      </form>
      <span className="flex items-center gap-2">
        {source.isActive ? null : <Badge>מוסתר</Badge>}
        <ActionButton action={setSourceActiveAction.bind(null, orgId, source.id, !source.isActive)} pendingText="מעדכן…" variant="ghost" srLabel={source.name}>
          {source.isActive ? "הסתרה" : "הצגה"}
        </ActionButton>
      </span>
    </li>
  );
}

export function AddSourceForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addSourceAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="flex items-start gap-2" noValidate>
      <TextField
        label="שם המקור החדש"
        hideLabel
        placeholder="מקור חדש, למשל: תערוכה"
        name="name"
        required
        maxLength={60}
        autoComplete="off"
        controlSize="sm"
        className="min-w-0 flex-1"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
      />
      <SubmitButton size="sm" pendingText="מוסיף…">
        הוספת מקור
      </SubmitButton>
    </form>
  );
}
