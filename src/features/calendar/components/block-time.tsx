"use client";

import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createBlockAction, deleteBlockAction, updateBlockAction } from "../block-actions";
import { BLOCK_DEFAULT_TITLE } from "../blocks";

type BlockValues = { title: string; date: string; start_time: string; end_time: string };

/** GAP-07: a calendar header button that blocks time (the person's own). */
export function BlockTimeButton({ orgId, today, timeZone }: { orgId: string; today: string; timeZone: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" className="print:hidden" onClick={() => setOpen(true)}>
        <PlusIcon className="size-5" aria-hidden="true" />
        חסימת זמן
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="חסימת זמן ביומן" variant="sheet">
        {open ? (
          <BlockForm
            orgId={orgId}
            blockId={null}
            timeZone={timeZone}
            initial={{ title: "", date: today, start_time: "12:00", end_time: "13:00" }}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

/** The fields of a block: what for (optional), the day and the hours. */
export function BlockForm({
  orgId,
  blockId,
  timeZone,
  initial,
  onDone,
}: {
  orgId: string;
  blockId: string | null;
  timeZone: string;
  initial: BlockValues;
  onDone: () => void;
}) {
  const action = blockId ? updateBlockAction.bind(null, orgId, blockId) : createBlockAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(action, null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const [date, setDate] = useState(values?.date ?? initial.date);

  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <p className="text-sm text-ink-soft">
        זמן חסום נראה ביומן כתפוס: דף קביעת התור לא יציע אותו, ומי שקובע פגישה איתך יקבל אזהרה. רק פגישות אמיתיות נספרות בדוחות.
      </p>
      {failure && !failure.fieldErrors ? <FormError message={failure.message} /> : null}
      <TextField
        label="מה חוסם את הזמן (לא חובה)"
        name="title"
        maxLength={300}
        placeholder={BLOCK_DEFAULT_TITLE}
        defaultValue={values?.title ?? (initial.title === BLOCK_DEFAULT_TITLE ? "" : initial.title)}
        error={errors.title}
      />
      <DateField label="תאריך" name="date" value={date} onChange={setDate} required timeZone={timeZone} error={errors.date} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="משעה" name="start_time" type="time" required defaultValue={values?.start_time ?? initial.start_time} error={errors.start_time} />
        <TextField label="עד שעה" name="end_time" type="time" required defaultValue={values?.end_time ?? initial.end_time} error={errors.end_time} />
      </div>
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingText="שומרים…">{blockId ? "שמירה" : "חסימת הזמן"}</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

/** In the calendar's details window of a block: change it, or free the time. */
export function BlockEditor({
  orgId,
  blockId,
  timeZone,
  initial,
  onDone,
}: {
  orgId: string;
  blockId: string;
  timeZone: string;
  initial: BlockValues;
  onDone: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <BlockForm orgId={orgId} blockId={blockId} timeZone={timeZone} initial={initial} onDone={() => onDone("הזמן החסום עודכן.")} />;
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
        עריכה
      </Button>
      <ConfirmButton
        title="לשחרר את הזמן החסום?"
        description="הזמן יחזור להיות פנוי, גם בדף קביעת התור."
        confirmLabel="שחרור הזמן"
        action={() => deleteBlockAction(orgId, blockId)}
        onDone={() => onDone("הזמן שוחרר.")}
      >
        שחרור הזמן
      </ConfirmButton>
    </div>
  );
}
