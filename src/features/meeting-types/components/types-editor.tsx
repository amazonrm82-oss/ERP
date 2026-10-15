"use client";

import { useActionState, useCallback, useEffect, useState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { PencilIcon, PlusIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { STAGE_COLORS } from "@/features/deals/stage-colors";
import { MEETING_TYPE_LABEL, MEETING_TYPE_OPTIONS } from "@/features/meetings/schema";
import { RequestedProductPicker } from "@/features/requested-product/components/requested-product-picker";
import type { FormState } from "@/lib/action-result";

import { addMeetingTypeAction, deleteMeetingTypeAction, moveMeetingTypeAction, updateMeetingTypeAction } from "../actions";
import type { MeetingTypeItem } from "../queries";
import { BUFFER_MAX, buffersText, DURATION_MAX, DURATION_MIN, durationText, MEETING_TYPE_LOCATION_MAX, MEETING_TYPE_NAME_MAX } from "../schema";

type ListProps = { orgId: string; types: MeetingTypeItem[]; editable: boolean; products: boolean };

/** CAL-08: the organization's meeting types: what each one fills into a new meeting. */
export function MeetingTypeList({ orgId, types, editable, products }: ListProps) {
  return (
    <ol className="divide-y divide-line">
      {types.map((type, index) => (
        <MeetingTypeRow
          key={type.id}
          orgId={orgId}
          type={type}
          editable={editable}
          products={products}
          isFirst={index === 0}
          isLast={index === types.length - 1}
        />
      ))}
    </ol>
  );
}

type RowProps = { orgId: string; type: MeetingTypeItem; editable: boolean; products: boolean; isFirst: boolean; isLast: boolean };

function MeetingTypeRow({ orgId, type, editable, products, isFirst, isLast }: RowProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const details = [
    durationText(type.durationMinutes),
    type.format ? MEETING_TYPE_LABEL[type.format] : null,
    buffersText(type.bufferBefore, type.bufferAfter),
  ].filter(Boolean);

  return (
    <li className="space-y-2 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words font-medium">{type.name}</span>
        {type.color ? <Badge tone={type.color}>{STAGE_COLORS.find((c) => c.value === type.color)?.label}</Badge> : null}
        {type.isActive ? null : <Badge tone="neutral">מוסתר</Badge>}
      </div>
      <p className="text-sm text-ink-soft">{details.join(" · ")}</p>
      {type.location ? <p className="break-words text-sm text-ink-soft">מיקום: {type.location}</p> : null}
      {type.product ? (
        <p className="text-sm text-ink-soft">
          שירות: <bdi>{type.product.name}</bdi>
          {type.product.offerable ? null : " (לא פעיל בקטלוג)"}
        </p>
      ) : null}
      {editable ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <PencilIcon className="size-4" />
            עריכה
            <span className="sr-only">: {type.name}</span>
          </Button>
          <ActionButton action={moveMeetingTypeAction.bind(null, orgId, type.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={type.name} disabled={isFirst}>
            הזזה למעלה
          </ActionButton>
          <ActionButton action={moveMeetingTypeAction.bind(null, orgId, type.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={type.name} disabled={isLast}>
            הזזה למטה
          </ActionButton>
          <ActionButton
            action={deleteMeetingTypeAction.bind(null, orgId, type.id)}
            pendingText="מוחקים…"
            variant="danger-ghost"
            srLabel={type.name}
            confirm={`למחוק את סוג הפגישה "${type.name}"? פגישות שכבר נקבעו בו נשארות כמו שהן, בלי סוג. אפשר גם להסתיר אותו בעריכה.`}
          >
            מחיקה
          </ActionButton>
        </div>
      ) : null}
      <Dialog open={open} onClose={close} title="עריכת סוג פגישה" description={type.name} variant="sheet">
        {open ? <MeetingTypeForm orgId={orgId} type={type} products={products} onDone={close} /> : null}
      </Dialog>
    </li>
  );
}

/** "סוג פגישה חדש": the same form, empty, in a window. */
export function AddMeetingTypeButton({ orgId, products }: { orgId: string; products: boolean }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <PlusIcon className="size-4" />
        סוג פגישה חדש
      </Button>
      <Dialog open={open} onClose={close} title="סוג פגישה חדש" variant="sheet">
        {open ? <MeetingTypeForm orgId={orgId} type={null} products={products} onDone={close} /> : null}
      </Dialog>
    </>
  );
}

type FormProps = { orgId: string; type: MeetingTypeItem | null; products: boolean; onDone: () => void };

function MeetingTypeForm({ orgId, type, products, onDone }: FormProps) {
  const action = type ? updateMeetingTypeAction.bind(null, orgId, type.id) : addMeetingTypeAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(action, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const values = failure?.values;

  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField
        label="שם"
        name="name"
        required
        maxLength={MEETING_TYPE_NAME_MAX}
        autoComplete="off"
        placeholder="למשל: פגישת ייעוץ"
        defaultValue={values?.name ?? type?.name ?? ""}
        error={errors.name}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="משך בדקות"
          name="duration_minutes"
          type="number"
          inputMode="numeric"
          required
          min={DURATION_MIN}
          max={DURATION_MAX}
          step={5}
          defaultValue={values?.duration_minutes ?? String(type?.durationMinutes ?? 30)}
          error={errors.duration_minutes}
        />
        <SelectField label="אופן הפגישה" name="meeting_format" defaultValue={values?.meeting_format ?? type?.format ?? ""} error={errors.meeting_format}>
          <option value="">לא נקבע</option>
          {MEETING_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </div>
      <TextField
        label="מיקום (לא חובה)"
        name="location"
        maxLength={MEETING_TYPE_LOCATION_MAX}
        hint="נכנס לפגישה חדשה מהסוג הזה, ואפשר לשנות אותו בכל פגישה."
        defaultValue={values?.location ?? type?.location ?? ""}
        error={errors.location}
      />
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">מרווח בין פגישות</legend>
        <p className="mb-2 text-sm text-ink-soft">זמן פנוי לפני הפגישה ואחריה, למשל לנסיעה או להכנה. היומן מזהיר כשפגישה אחרת נקבעת בזמן הזה.</p>
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label="לפני, בדקות"
            name="buffer_before_minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={BUFFER_MAX}
            step={5}
            defaultValue={values?.buffer_before_minutes ?? String(type?.bufferBefore ?? 0)}
            error={errors.buffer_before_minutes}
          />
          <TextField
            label="אחרי, בדקות"
            name="buffer_after_minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={BUFFER_MAX}
            step={5}
            defaultValue={values?.buffer_after_minutes ?? String(type?.bufferAfter ?? 0)}
            error={errors.buffer_after_minutes}
          />
        </div>
      </fieldset>
      <SelectField label="צבע ביומן" name="color" defaultValue={values?.color ?? type?.color ?? ""} error={errors.color}>
        <option value="">בלי צבע</option>
        {STAGE_COLORS.map((color) => (
          <option key={color.value} value={color.value}>
            {color.label}
          </option>
        ))}
      </SelectField>
      {products ? (
        <RequestedProductPicker
          orgId={orgId}
          name="product_id"
          label="שירות מהקטלוג (לא חובה)"
          hint="השירות שהפגישה הזו מוכרת. מוצרים פעילים מהקטלוג."
          initial={type?.product ? { id: type.product.id, name: type.product.name, note: type.product.offerable ? null : "לא פעיל בקטלוג" } : null}
          error={errors.product_id}
        />
      ) : null}
      <Checkbox
        name="is_active"
        label="מוצע בפגישה חדשה"
        hint="סוג מוסתר לא מוצע יותר, ופגישות שכבר נקבעו בו נשארות כמו שהן."
        defaultChecked={values ? values.is_active === "on" : (type?.isActive ?? true)}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingText="שומרים…">{type ? "שמירה" : "הוספה"}</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
