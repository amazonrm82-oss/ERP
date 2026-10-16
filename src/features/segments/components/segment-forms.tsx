"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import type { FilterTree } from "@/features/list-filters/model";

import { createSegmentAction, deleteSegmentAction, renameSegmentAction } from "../actions";
import { SEGMENT_OBJECT_LABELS, SEGMENT_OBJECTS, type SegmentObject } from "../model";
import { segmentPath, segmentsPath } from "../paths";

/** A new hand-picked (static) segment, on the segments page. Records are added from the list, by picking rows. */
export function NewStaticSegmentForm({ orgId }: { orgId: string }) {
  const [state, formAction, pending] = useActionState<FormState<{ id: string }>, FormData>(createSegmentAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const created = state && state.ok ? state.data : undefined;

  return (
    <form action={formAction} className="flex flex-wrap items-start gap-2" noValidate>
      <input type="hidden" name="kind" value="static" />
      <TextField
        label="שם הסגמנט"
        name="name"
        required
        maxLength={80}
        autoComplete="off"
        className="min-w-0 flex-[1_1_14rem]"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name}
      />
      <SelectField label="של" name="object_type" defaultValue={failure?.values?.object_type ?? "lead"} className="flex-[0_1_10rem]" error={failure?.fieldErrors?.object_type}>
        {SEGMENT_OBJECTS.map((key) => (
          <option key={key} value={key}>
            {SEGMENT_OBJECT_LABELS[key]}
          </option>
        ))}
      </SelectField>
      <div className="pt-6.5">
        <SubmitButton pending={pending}>יצירה</SubmitButton>
      </div>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} className="basis-full" />
      {created ? (
        <p role="status" className="basis-full text-sm">
          הסגמנט נוצר.{" "}
          <Link href={segmentPath(orgId, created.id)} className="font-medium text-accent-strong underline-offset-2 hover:underline">
            פתיחת הסגמנט
          </Link>
        </p>
      ) : null}
    </form>
  );
}

/** "Save as segment" on a filtered list: a dynamic segment that keeps the list's filter. */
export function SaveAsSegment({ orgId, objectType, filter }: { orgId: string; objectType: SegmentObject; filter: FilterTree }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<FormState<{ id: string }>, FormData>(async (prev, formData) => {
    const result = await createSegmentAction(orgId, prev, formData);
    if (result?.ok) setOpen(false);
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const created = state && state.ok ? state.data : undefined;

  if (!open) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          שמירה כסגמנט
        </Button>
        {created ? (
          <span role="status" className="text-sm">
            נשמר.{" "}
            <Link href={segmentPath(orgId, created.id)} className="font-medium text-accent-strong underline-offset-2 hover:underline">
              לסגמנט
            </Link>
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <form action={formAction} className="flex w-full flex-wrap items-start gap-2 rounded-md border border-line bg-surface p-3" noValidate>
      <input type="hidden" name="kind" value="dynamic" />
      <input type="hidden" name="object_type" value={objectType} />
      <input type="hidden" name="filter" value={JSON.stringify(filter)} />
      <TextField
        label="שם הסגמנט"
        name="name"
        required
        maxLength={80}
        autoComplete="off"
        controlSize="sm"
        className="min-w-0 flex-[1_1_12rem]"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name}
        hint="נשמר הסינון המתקדם (בלי החיפוש והתגית). בכל כניסה לסגמנט רואים את מי שמתאים לו באותו רגע."
      />
      <div className="flex gap-2 pt-6.5">
        <SubmitButton size="sm" pending={pending}>
          שמירה
        </SubmitButton>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          ביטול
        </Button>
      </div>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} className="basis-full" />
    </form>
  );
}

/** Renaming a segment, on its page. */
export function RenameSegmentForm({ orgId, segmentId, name }: { orgId: string; segmentId: string; name: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(renameSegmentAction.bind(null, orgId, segmentId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="flex flex-wrap items-start gap-2" noValidate>
      <TextField
        label="שם הסגמנט"
        name="name"
        required
        maxLength={80}
        autoComplete="off"
        className="min-w-0 flex-[1_1_14rem]"
        defaultValue={failure?.values?.name ?? name}
        error={failure?.fieldErrors?.name}
      />
      <div className="pt-6.5">
        <SubmitButton variant="secondary" pending={pending}>
          שמירת השם
        </SubmitButton>
      </div>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} className="basis-full" />
      {state?.ok ? <FormNotice message={state.message ?? "נשמר."} className="basis-full" /> : null}
    </form>
  );
}

/** Removes the segment after asking, then goes back to the segments page. */
export function DeleteSegmentButton({ orgId, segmentId, name }: { orgId: string; segmentId: string; name: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await deleteSegmentAction(orgId, segmentId);
      if (!result.ok) {
        setError(result.message);
        setAsking(false);
        return;
      }
      router.push(segmentsPath(orgId));
    });
  }

  return (
    <div className="space-y-2">
      {asking ? (
        <div role="group" aria-label="אישור מחיקה" className="flex flex-wrap items-center gap-2">
          <span className="text-md">למחוק את הסגמנט &quot;{name}&quot;? הרשומות עצמן לא נמחקות.</span>
          <Button variant="danger" size="sm" onClick={run} loading={pending}>
            מחיקת הסגמנט
          </Button>
          <Button variant="secondary" size="sm" autoFocus onClick={() => setAsking(false)} disabled={pending}>
            לא עכשיו
          </Button>
        </div>
      ) : (
        <Button variant="danger-ghost" size="sm" onClick={() => setAsking(true)}>
          מחיקת הסגמנט
        </Button>
      )}
      <FormError message={error} />
    </div>
  );
}
