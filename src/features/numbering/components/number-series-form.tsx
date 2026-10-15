"use client";

import { useActionState, useState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { jumpNumberSeriesAction, saveNumberSeriesAction } from "../actions";
import { displayNumber, jumpGapText, jumpProblem, nextNumber, PREFIX_MAX, SERIES_LABELS, START_MAX, START_MIN, startLocked, usedText, type NumberSeries } from "../series";

type Props = { orgId: string; series: NumberSeries };

/** The prefix and the start of one number series (QUO-03). Owners and admins of a writable business. */
export function NumberSeriesForm({ orgId, series }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveNumberSeriesAction.bind(null, orgId, series.kind), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const locked = startLocked(series);
  const [prefix, setPrefix] = useState(failure?.values?.prefix ?? series.prefix);
  const [start, setStart] = useState(failure?.values?.start_number ?? String(series.startNumber));
  const labels = SERIES_LABELS[series.kind];
  const titleId = `numbering-${series.kind}-title`;

  // what the next document will be called, as typed (the database decides the real number)
  const typedStart = Number(start);
  const previewNumber = locked ? nextNumber(series) : Number.isInteger(typedStart) && typedStart >= START_MIN ? typedStart : null;
  const preview = previewNumber === null ? null : displayNumber(prefix.trim(), previewNumber);

  return (
    <Card aria-labelledby={titleId}>
      <CardHeader id={titleId} title={labels.title} />
      <CardBody className="space-y-5">
        <form action={formAction} noValidate className="space-y-5">
          <TextField
            label="קידומת"
            name="prefix"
            dir="ltr"
            maxLength={PREFIX_MAX}
            autoComplete="off"
            className="max-w-48"
            hint={`לא חובה. עד ${PREFIX_MAX} תווים: אותיות, ספרות והסימנים - / . _, לא ספרה בסוף (למשל ${labels.example}). אפשר לשנות אותה בכל זמן; היא חלה על המסמכים הבאים.`}
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
            error={errors.prefix}
          />

          {locked ? (
            <p className="text-sm">
              <span className="font-medium">מספר התחלתי: </span>
              <span dir="ltr">{series.startNumber}</span>
              <span className="block text-ink-soft">כבר ניתן מספר בסדרה הזו, ולכן המספר ההתחלתי נשאר כמו שהוא.</span>
            </p>
          ) : (
            <TextField
              label="מספר התחלתי"
              name="start_number"
              type="number"
              inputMode="numeric"
              min={START_MIN}
              max={START_MAX}
              step={1}
              dir="ltr"
              className="max-w-48"
              hint="המספר של המסמך הראשון. אפשר לשנות אותו רק עד שניתן המספר הראשון."
              value={start}
              onChange={(event) => setStart(event.target.value)}
              error={errors.start_number}
            />
          )}

          <div className="rounded-md bg-canvas p-3 text-sm" aria-live="polite">
            <p>
              <span className="font-medium">המסמך הבא יקבל: </span>
              {preview ? <span dir="ltr">{preview}</span> : <span className="text-ink-soft">יוצג אחרי שתכתבו מספר התחלתי</span>}
            </p>
            <p className="mt-1 text-ink-soft">{usedText(series)}</p>
          </div>

          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </form>
        {/* outside the save form, so Enter in the jump field never submits it */}
        {locked ? <NumberJump orgId={orgId} series={series} /> : null}
      </CardBody>
    </Card>
  );
}

/** Jump forward (owner, 14 October 2026): a higher next number, after a confirmation. */
function NumberJump({ orgId, series }: Props) {
  const [value, setValue] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const last = series.lastNumber ?? 0;
  const typed = value.trim() === "" ? null : Number(value.trim());
  const problem = typed === null ? null : jumpProblem(series, typed);
  const target = typed !== null && problem === null ? typed : null;

  return (
    <div className="space-y-3 rounded-md border border-line p-3">
      <TextField
        label="קפיצה קדימה במספור"
        type="number"
        inputMode="numeric"
        min={last + 2}
        max={START_MAX}
        step={1}
        dir="ltr"
        className="max-w-48"
        hint={`אפשר לקבוע מספר הבא גבוה יותר מ-${nextNumber(series)}. המספרים שבדרך לא ישמשו לעולם.`}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setDone(null);
        }}
        error={problem ?? undefined}
      />
      <ConfirmButton
        variant="secondary"
        title={target !== null ? `המסמך הבא יקבל את המספר ${displayNumber(series.prefix, target)}` : "קפיצה קדימה במספור"}
        description={target !== null ? jumpGapText(series.prefix, last, target) : undefined}
        confirmLabel="לקפוץ קדימה"
        disabled={target === null}
        action={() => jumpNumberSeriesAction(orgId, series.kind, target)}
        onDone={() => {
          setDone(`המסמך הבא יקבל את המספר ${target}.`);
          setValue("");
        }}
      >
        קפיצה קדימה
      </ConfirmButton>
      <FormNotice message={done} />
    </div>
  );
}
