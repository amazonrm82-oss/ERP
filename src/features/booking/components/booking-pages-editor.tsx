"use client";

import { useActionState, useCallback, useEffect, useId, useState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, Input, Label, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { PencilIcon, PlusIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { addBookingPageAction, deleteBookingPageAction, updateBookingPageAction } from "../actions";
import type { BookingPageItem } from "../queries";
import {
  BOOKING_INTRO_MAX,
  BOOKING_QUESTION_MAX,
  BOOKING_QUESTIONS_MAX,
  BOOKING_TITLE_MAX,
  DEFAULT_MAX_DAYS_AHEAD,
  DEFAULT_MIN_NOTICE,
  DEFAULT_SLOT_STEP,
  MAX_DAYS_AHEAD_MAX,
  MAX_DAYS_AHEAD_MIN,
  MIN_NOTICE_OPTIONS,
  minNoticeText,
  SLOT_STEP_OPTIONS,
  CANCEL_NOTICE_OPTIONS,
  DEFAULT_CANCEL_NOTICE,
} from "../schema";

export type BookingOption = { id: string; name: string };

type Shared = {
  orgId: string;
  // active meeting types (a page's own hidden type is added to its own form)
  types: BookingOption[];
  sources: BookingOption[];
  // owners and admins pick the rep; null = everyone else, whose pages are their own
  reps: BookingOption[] | null;
  // the public link's start, e.g. https://app.example/f/book/
  linkBase: string;
};

/** CAL-10: the booking pages the user may see, each with its link. */
export function BookingPageList({ pages, noHours, editable, ...shared }: Shared & { pages: BookingPageItem[]; noHours: string[]; editable: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {pages.map((page) => (
        <BookingPageRow key={page.id} page={page} noHours={noHours.includes(page.userId)} editable={editable} {...shared} />
      ))}
    </ul>
  );
}

function BookingPageRow({ page, noHours, editable, ...shared }: Shared & { page: BookingPageItem; noHours: boolean; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const url = `${shared.linkBase}${page.token}`;
  const details = [page.meetingTypeName ?? "בלי סוג פגישה", `קביעה ${minNoticeText(page.minNoticeMinutes)}`, `עד ${page.maxDaysAhead} ימים קדימה`];

  return (
    <li className="space-y-2 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words font-medium">{page.title}</span>
        {page.isActive ? <Badge tone="success">פעיל</Badge> : <Badge tone="neutral">כבוי</Badge>}
      </div>
      <p className="text-sm text-ink-soft">
        עם <bdi>{page.repName}</bdi> · {details.join(" · ")}
      </p>
      {page.isActive && !page.meetingTypeUsable ? (
        <p role="status" className="text-sm text-warning">
          סוג הפגישה של הדף נמחק או הוסתר, ולכן הדף לא נפתח. בחרו סוג אחר בעריכה.
        </p>
      ) : null}
      {noHours ? (
        <p role="status" className="text-sm text-warning">
          {page.isActive
            ? "אין שעות עבודה לנציג או לעסק, ולכן הדף לא מתפרסם: מי שנכנס לקישור רואה שהדף לא נמצא."
            : "אין שעות עבודה לנציג או לעסק, ולכן אי אפשר להפעיל את הדף."}{" "}
          אפשר להגדיר אותן בהגדרות &gt; שעות וימי מנוחה, או בחשבון של הנציג.
        </p>
      ) : null}
      <BookingLink url={url} title={page.title} />
      {editable ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <PencilIcon className="size-4" />
            עריכה
            <span className="sr-only">: {page.title}</span>
          </Button>
          <ActionButton
            action={deleteBookingPageAction.bind(null, shared.orgId, page.id)}
            pendingText="מוחקים…"
            variant="danger-ghost"
            srLabel={page.title}
            confirm={`למחוק את הדף "${page.title}"? הקישור יפסיק לעבוד. פגישות שכבר נקבעו דרכו נשארות.`}
          >
            מחיקה
          </ActionButton>
        </div>
      ) : null}
      <Dialog open={open} onClose={close} title="עריכת דף קביעת תור" description={page.title} variant="sheet">
        {open ? <BookingPageForm {...shared} page={page} onDone={close} /> : null}
      </Dialog>
    </li>
  );
}

/** The page's public link: copy, send in WhatsApp, open. */
function BookingLink({ url, title }: { url: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="sr-only">
        הקישור לדף: {title}
      </Label>
      <Input id={id} value={url} readOnly dir="ltr" className="font-mono text-sm" onFocus={(event) => event.currentTarget.select()} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {
              // clipboard blocked: the link is selectable in the field
              setCopied(false);
            }
          }}
        >
          {copied ? "הקישור הועתק" : "העתקת הקישור"}
          <span className="sr-only">: {title}</span>
        </Button>
        <a href={`https://wa.me/?text=${encodeURIComponent(`${title}\n${url}`)}`} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "sm")}>
          שליחה ב-WhatsApp
          <span className="sr-only">: {title}</span>
        </a>
        <a href={url} target="_blank" rel="noopener" className={buttonClasses("secondary", "sm")}>
          פתיחת הדף
          <span className="sr-only">: {title}</span>
        </a>
      </div>
    </div>
  );
}

/** "דף חדש": the same form, empty, in a window. */
export function AddBookingPageButton(shared: Shared) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <PlusIcon className="size-4" />
        דף קביעת תור חדש
      </Button>
      <Dialog open={open} onClose={close} title="דף קביעת תור חדש" variant="sheet">
        {open ? <BookingPageForm {...shared} page={null} onDone={close} /> : null}
      </Dialog>
    </>
  );
}

function BookingPageForm({ orgId, types, sources, reps, page, onDone }: Shared & { page: BookingPageItem | null; onDone: () => void }) {
  const action = page ? updateBookingPageAction.bind(null, orgId, page.id) : addBookingPageAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(action, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const values = failure?.values;
  // the page's own type stays offered while hidden, marked
  const typeOptions =
    page?.meetingTypeId && !types.some((t) => t.id === page.meetingTypeId)
      ? [...types, { id: page.meetingTypeId, name: `${page.meetingTypeName ?? "סוג"} (מוסתר)` }]
      : types;
  // the page's own rep stays offered while no longer in the list (suspended, or out of a manager's teams)
  const repOptions = reps && page && !reps.some((r) => r.id === page.userId) ? [...reps, { id: page.userId, name: page.repName }] : reps;
  const initialQuestions = page?.questions ?? [];
  const [rows, setRows] = useState(Math.min(BOOKING_QUESTIONS_MAX, Math.max(1, initialQuestions.length)));

  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField
        label="כותרת הדף"
        name="title"
        required
        maxLength={BOOKING_TITLE_MAX}
        autoComplete="off"
        placeholder="למשל: קביעת פגישת ייעוץ"
        defaultValue={values?.title ?? page?.title ?? ""}
        error={errors.title}
      />
      <TextareaField
        label="הסבר קצר (לא חובה)"
        name="intro"
        rows={2}
        maxLength={BOOKING_INTRO_MAX}
        defaultValue={values?.intro ?? page?.intro ?? ""}
        error={errors.intro}
      />
      <SelectField
        label="סוג הפגישה"
        name="meeting_type_id"
        required
        hint="המשך, המיקום והמרווח לפני ואחרי באים מהסוג."
        defaultValue={values?.meeting_type_id ?? page?.meetingTypeId ?? ""}
        error={errors.meeting_type_id}
      >
        <option value="">בחירת סוג</option>
        {typeOptions.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </SelectField>
      {repOptions ? (
        <SelectField label="עם מי נקבעת הפגישה" name="user_id" defaultValue={values?.user_id ?? page?.userId ?? ""} error={errors.user_id}>
          <option value="">איתי</option>
          {repOptions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      <SelectField
        label="מקור ליד חדש (לא חובה)"
        name="source_id"
        hint="מי שקובע ואינו מוכר נרשם כליד עם המקור הזה. בלי בחירה: המקור דף קביעת תור."
        defaultValue={values?.source_id ?? page?.sourceId ?? ""}
        error={errors.source_id}
      >
        <option value="">דף קביעת תור (ברירת מחדל)</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </SelectField>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          label="אפשר לקבוע"
          name="min_notice_minutes"
          defaultValue={values?.min_notice_minutes ?? String(page?.minNoticeMinutes ?? DEFAULT_MIN_NOTICE)}
          error={errors.min_notice_minutes}
        >
          {MIN_NOTICE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        <TextField
          label="עד כמה ימים קדימה"
          name="max_days_ahead"
          type="number"
          inputMode="numeric"
          required
          min={MAX_DAYS_AHEAD_MIN}
          max={MAX_DAYS_AHEAD_MAX}
          defaultValue={values?.max_days_ahead ?? String(page?.maxDaysAhead ?? DEFAULT_MAX_DAYS_AHEAD)}
          error={errors.max_days_ahead}
        />
        <SelectField
          label="זמני התחלה"
          name="slot_step_minutes"
          defaultValue={values?.slot_step_minutes ?? String(page?.slotStepMinutes ?? DEFAULT_SLOT_STEP)}
          error={errors.slot_step_minutes}
        >
          {SLOT_STEP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      </div>
      <SelectField
        label="ביטול או שינוי בקישור האישי"
        name="cancel_notice_hours"
        hint="מי שקבע מקבל קישור אישי לביטול או לשינוי. אחרי המועד הזה הדף מבקש להתקשר לעסק."
        defaultValue={values?.cancel_notice_hours ?? String(page?.cancelNoticeHours ?? DEFAULT_CANCEL_NOTICE)}
        error={errors.cancel_notice_hours}
      >
        {CANCEL_NOTICE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </SelectField>
      <fieldset className="space-y-3">
        <legend className="mb-1.5 text-sm font-medium">שאלות מקדימות (לא חובה)</legend>
        <p className="text-sm text-ink-soft">מי שקובע עונה עליהן, והתשובות נשמרות בתיאור הפגישה.</p>
        {Array.from({ length: rows }, (_, n) => {
          const question = initialQuestions[n];
          return (
            <div key={n} className="space-y-1.5 rounded-md border border-line p-3">
              {question ? <input type="hidden" name={`question_id_${n}`} value={question.id} /> : null}
              <TextField
                label={`שאלה ${n + 1}`}
                name={`question_${n}`}
                maxLength={BOOKING_QUESTION_MAX}
                autoComplete="off"
                defaultValue={values?.[`question_${n}`] ?? question?.label ?? ""}
              />
              <Checkbox
                name={`question_required_${n}`}
                label="חובה לענות"
                defaultChecked={values ? values[`question_required_${n}`] === "on" : (question?.required ?? false)}
              />
            </div>
          );
        })}
        {rows < BOOKING_QUESTIONS_MAX ? (
          <Button size="sm" variant="ghost" onClick={() => setRows((r) => Math.min(BOOKING_QUESTIONS_MAX, r + 1))}>
            <PlusIcon className="size-4" />
            עוד שאלה
          </Button>
        ) : null}
      </fieldset>
      <Checkbox
        name="is_active"
        label="הדף פעיל"
        hint="דף כבוי מציג למי שנכנס לקישור שהוא לא נמצא."
        defaultChecked={values ? values.is_active === "on" : (page?.isActive ?? true)}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingText="שומרים…">{page ? "שמירה" : "יצירת הדף"}</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
