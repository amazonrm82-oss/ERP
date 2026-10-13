"use client";

import { useActionState, useState, type ReactNode } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { DEFAULT_ROT_DAYS, MAX_ROT_DAYS, STAGE_COLORS, stageColor, stageTone } from "@/features/deals/stage-colors";
import type { StageKind } from "@/lib/database.types";
import type { FormState } from "@/lib/action-result";

import {
  addStageAction,
  createPipelineAction,
  deletePipelineAction,
  deleteStageAction,
  moveStageAction,
  renamePipelineAction,
  setDefaultPipelineAction,
  updateStageAction,
} from "../actions-pipelines";
import { STAGE_KIND_LABELS } from "../labels";
import type { PipelineSetting, StageSetting } from "../queries";
import { STAGE_KINDS } from "../schema";

export function CreatePipelineForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(createPipelineAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <TextField
          label="שם תהליך המכירה"
          name="name"
          required
          maxLength={80}
          autoComplete="off"
          placeholder="למשל: מכירות לעסקים"
          className="flex-1"
          defaultValue={failure?.values?.name}
          error={failure?.fieldErrors?.name}
        />
        <SubmitButton className="sm:mt-6.5" pendingText="יוצרים…">
          יצירת תהליך מכירה
        </SubmitButton>
      </div>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
    </form>
  );
}

type CardProps = { orgId: string; pipeline: PipelineSetting; editable: boolean; isOnly: boolean };

/** One pipeline: its name, default flag and stages, editable by admins. */
export function PipelineCard({ orgId, pipeline, editable, isOnly }: CardProps) {
  const headingId = `pipeline-${pipeline.id}`;
  return (
    <Card aria-labelledby={headingId}>
      <CardHeader
        id={headingId}
        title={pipeline.name}
        action={pipeline.isDefault ? <Badge tone="accent">ברירת מחדל</Badge> : null}
      />
      <CardBody className="space-y-5">
        {editable ? (
          <div className="flex flex-wrap items-end gap-3">
            <RenamePipelineForm key={pipeline.name} orgId={orgId} pipeline={pipeline} />
            {pipeline.isDefault ? null : (
              <ActionButton action={setDefaultPipelineAction.bind(null, orgId, pipeline.id)} pendingText="מעדכנים…" srLabel={pipeline.name}>
                קביעה כברירת מחדל
              </ActionButton>
            )}
            {pipeline.isDefault || isOnly ? null : (
              <ActionButton
                action={deletePipelineAction.bind(null, orgId, pipeline.id)}
                pendingText="מוחקים…"
                variant="danger-ghost"
                confirm={`למחוק את תהליך המכירה "${pipeline.name}"?`}
              >
                מחיקת תהליך המכירה
              </ActionButton>
            )}
          </div>
        ) : null}

        <div>
          <h3 className="mb-2 text-sm font-medium text-ink-soft">שלבים, לפי הסדר בלוח</h3>
          <ol className="divide-y divide-line rounded-md border border-line">
            {pipeline.stages.map((stage, index) => (
              <StageRow
                key={`${stage.id}-${stage.name}-${stage.kind}-${stage.probability}-${stage.color}-${stage.rotDays}`}
                orgId={orgId}
                stage={stage}
                editable={editable}
                isFirst={index === 0}
                isLast={index === pipeline.stages.length - 1}
              />
            ))}
          </ol>
        </div>

        {editable ? <AddStageForm key={pipeline.stages.length} orgId={orgId} pipelineId={pipeline.id} /> : null}
      </CardBody>
    </Card>
  );
}

function RenamePipelineForm({ orgId, pipeline }: { orgId: string; pipeline: PipelineSetting }) {
  const [state, formAction] = useActionState<FormState, FormData>(renamePipelineAction.bind(null, orgId, pipeline.id), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="flex flex-wrap items-start gap-2" noValidate>
      <TextField
        label="שם"
        name="name"
        required
        maxLength={80}
        autoComplete="off"
        controlSize="sm"
        className="w-56"
        defaultValue={failure?.values?.name ?? pipeline.name}
        error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
      />
      <SubmitButton size="sm" variant="secondary" className="mt-6.5">
        שמירת שם
      </SubmitButton>
    </form>
  );
}

type StageRowProps = { orgId: string; stage: StageSetting; editable: boolean; isFirst: boolean; isLast: boolean };

function StageRow({ orgId, stage, editable, isFirst, isLast }: StageRowProps) {
  const [state, formAction] = useActionState<FormState, FormData>(updateStageAction.bind(null, orgId, stage.id), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};

  if (!editable) {
    return (
      <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2.5">
        <Badge tone={stageTone(stage)}>{stage.name}</Badge>
        <span className="text-sm text-ink-soft">
          {STAGE_KIND_LABELS[stage.kind]}, {stage.probability}%{stage.kind === "open" ? `, ${rotDaysText(stage.rotDays)}` : null}
        </span>
      </li>
    );
  }

  const kind = (values?.kind as StageKind | undefined) ?? stage.kind;
  return (
    <li className="space-y-2 px-3 py-3">
      <form action={formAction} className="space-y-2" noValidate>
        <div className="grid grid-cols-2 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_6rem]">
          <TextField
            label={`שם השלב`}
            hideLabel
            name="name"
            required
            maxLength={80}
            autoComplete="off"
            controlSize="sm"
            className="col-span-2 sm:col-span-1"
            defaultValue={values?.name ?? stage.name}
            error={errors.name}
          />
          <SelectField
            key={`kind-${kind}`}
            label={`סוג השלב ${stage.name}`}
            hideLabel
            name="kind"
            controlSize="sm"
            defaultValue={kind}
            error={errors.kind}
          >
            {STAGE_KINDS.map((option) => (
              <option key={option} value={option}>
                {STAGE_KIND_LABELS[option]}
              </option>
            ))}
          </SelectField>
          <TextField
            label={`הסתברות לסגירה בשלב ${stage.name} (באחוזים)`}
            hideLabel
            name="probability"
            dir="ltr"
            inputMode="numeric"
            controlSize="sm"
            defaultValue={values?.probability ?? String(stage.probability)}
            error={errors.probability}
          />
        </div>
        <StageLookFields
          stageName={stage.name}
          kind={kind}
          color={values?.color ?? stage.color ?? ""}
          rotDays={values?.rot_days ?? (stage.rotDays === null ? "" : String(stage.rotDays))}
          errors={errors}
        >
          <SubmitButton size="sm" variant="secondary" className="col-span-2 sm:col-span-1 sm:mt-6.5">
            שמירה
            <span className="sr-only">: {stage.name}</span>
          </SubmitButton>
        </StageLookFields>
      </form>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        <span>{stage.dealCount === 1 ? "עסקה אחת" : `${stage.dealCount} עסקאות`}</span>
        <ActionButton action={moveStageAction.bind(null, orgId, stage.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={stage.name} disabled={isFirst}>
          הזזה למעלה
        </ActionButton>
        <ActionButton action={moveStageAction.bind(null, orgId, stage.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={stage.name} disabled={isLast}>
          הזזה למטה
        </ActionButton>
        <ActionButton
          action={deleteStageAction.bind(null, orgId, stage.id)}
          pendingText="מוחקים…"
          variant="danger-ghost"
          confirm={`למחוק את השלב "${stage.name}"?`}
        >
          מחיקה
        </ActionButton>
      </div>
    </li>
  );
}

function AddStageForm({ orgId, pipelineId }: { orgId: string; pipelineId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addStageAction.bind(null, orgId, pipelineId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-2" noValidate>
      <h3 className="text-sm font-medium text-ink-soft">שלב חדש</h3>
      <div className="grid grid-cols-2 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_6rem]">
        <TextField
          label="שם השלב החדש"
          hideLabel
          name="name"
          placeholder="שם השלב"
          required
          maxLength={80}
          autoComplete="off"
          controlSize="sm"
          className="col-span-2 sm:col-span-1"
          defaultValue={values?.name}
          error={errors.name}
        />
        <SelectField label="סוג השלב החדש" hideLabel name="kind" controlSize="sm" defaultValue={values?.kind ?? "open"}>
          {STAGE_KINDS.map((option) => (
            <option key={option} value={option}>
              {STAGE_KIND_LABELS[option]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="הסתברות לסגירה בשלב החדש (באחוזים)"
          hideLabel
          name="probability"
          dir="ltr"
          inputMode="numeric"
          placeholder="%"
          controlSize="sm"
          defaultValue={values?.probability ?? "20"}
          error={errors.probability}
        />
      </div>
      <StageLookFields
        stageName="השלב החדש"
        kind={(values?.kind as StageKind | undefined) ?? "open"}
        color={values?.color ?? ""}
        rotDays={values?.rot_days ?? ""}
        errors={errors}
        isNew
      >
        <SubmitButton size="sm" className="col-span-2 sm:col-span-1 sm:mt-6.5" pendingText="מוסיפים…">
          הוספת שלב
        </SubmitButton>
      </StageLookFields>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
    </form>
  );
}

function rotDaysText(rotDays: number | null): string {
  const days = rotDays ?? DEFAULT_ROT_DAYS;
  const text = days === 1 ? "יום אחד" : `${days} ימים`;
  return `תקועה אחרי ${text} בשלב${rotDays === null ? " (ברירת מחדל)" : ""}`;
}

type LookProps = {
  stageName: string;
  kind: StageKind;
  color: string;
  rotDays: string;
  errors: Record<string, string | undefined>;
  isNew?: boolean;
  children: ReactNode;
};

// what report_stuck_deals measures: days since the deal entered the stage (owner, 13 October 2026)
const ROT_DAYS_LABEL = "ימים מרביים בשלב";

/** DEAL-01: the stage's colour (from the design-system palette) and the days a deal may sit in it. */
function StageLookFields({ stageName, kind, color, rotDays, errors, isNew, children }: LookProps) {
  const [picked, setPicked] = useState(color);
  const of = isNew ? "של השלב החדש" : `של השלב ${stageName}`;
  return (
    <div className="grid grid-cols-2 items-start gap-2 sm:grid-cols-[9rem_14rem_auto_auto]">
      <SelectField
        label="צבע"
        name="color"
        controlSize="sm"
        aria-label={`צבע ${of}`}
        defaultValue={color}
        onChange={(event) => setPicked(event.target.value)}
        error={errors.color}
      >
        <option value="">לפי סוג השלב</option>
        {STAGE_COLORS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      {kind === "open" ? (
        <TextField
          label={ROT_DAYS_LABEL}
          name="rot_days"
          aria-label={`${ROT_DAYS_LABEL}, ${of}`}
          dir="ltr"
          inputMode="numeric"
          maxLength={3}
          autoComplete="off"
          controlSize="sm"
          placeholder={String(DEFAULT_ROT_DAYS)}
          hint={`ריק = ${DEFAULT_ROT_DAYS} ימים. עד ${MAX_ROT_DAYS}.`}
          defaultValue={rotDays}
          error={errors.rot_days}
        />
      ) : (
        // won and lost stages are never stuck: keep what is stored
        <input type="hidden" name="rot_days" value={rotDays} />
      )}
      <p className="col-span-2 flex items-center gap-2 text-sm text-ink-soft sm:col-span-1 sm:mt-7.5" aria-hidden="true">
        <Badge tone={stageTone({ kind, color: stageColor(picked) })}>{isNew ? "שלב חדש" : stageName}</Badge>
      </p>
      {children}
    </div>
  );
}
