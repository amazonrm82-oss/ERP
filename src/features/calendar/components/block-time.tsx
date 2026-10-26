"use client";

import { useActionState, useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, TextField } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConflictWarning } from "@/features/meetings/components/conflict-warning";
import { DEFAULT_SERIES_COUNT, lastSeriesDate, SERIES_MAX, SERIES_MIN } from "@/features/meetings/series";
import { longDay } from "@/lib/calendar-grid";

import { createBlockAction, deleteBlockAction, releaseFollowingBlocksAction, releaseFollowingCountAction, updateBlockAction } from "../block-actions";
import { BLOCK_DEFAULT_TITLE, blockSeriesLabel, type BlockFormState } from "../blocks";

// the rest-day warning names days only (no people), so the span it is about is never shown
const NO_SPAN = { startsAt: "1970-01-01T00:00:00.000Z", endsAt: "1970-01-01T00:00:00.000Z" };

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
            seriesIndex={null}
            timeZone={timeZone}
            initial={{ title: "", date: today, start_time: "12:00", end_time: "13:00" }}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

/**
 * The fields of a block: what for (optional), the day and the hours. A new block may repeat every week (owner, 18 October
 * 2026: the CAL-09 series mechanism); a block of a series asks what a change applies to.
 */
export function BlockForm({
  orgId,
  blockId,
  seriesIndex,
  timeZone,
  initial,
  onDone,
}: {
  orgId: string;
  blockId: string | null;
  // the block's place in its weekly series, null for a single block
  seriesIndex: number | null;
  timeZone: string;
  initial: BlockValues;
  onDone: (message?: string) => void;
}) {
  const action = blockId ? updateBlockAction.bind(null, orgId, blockId) : createBlockAction.bind(null, orgId);
  const [state, formAction] = useActionState<BlockFormState, FormData>(action, null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const [date, setDate] = useState(values?.date ?? initial.date);
  const [repeat, setRepeat] = useState(values?.repeat === "weekly");
  const [count, setCount] = useState(values?.series_count ?? String(DEFAULT_SERIES_COUNT));
  const countNumber = Number(count);
  const until = repeat && /^\d+$/.test(count) && countNumber >= SERIES_MIN && countNumber <= SERIES_MAX && date ? lastSeriesDate(date, countNumber) : null;
  const restDays = failure?.restDays ?? null;
  const split = failure?.split ?? null;

  useEffect(() => {
    if (state?.ok) onDone(state.message);
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <p className="text-sm text-ink-soft">
        זמן חסום נראה ביומן כתפוס: דף קביעת התור לא יציע אותו, ומי שקובע פגישה איתך יקבל אזהרה. רק פגישות אמיתיות נספרות בדוחות.
      </p>
      {failure && !failure.fieldErrors && !restDays && !split ? <FormError message={failure.message} /> : null}
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
      {blockId ? null : (
        <div className="space-y-3 rounded-md border border-line p-3">
          <Checkbox
            name="repeat"
            value="weekly"
            label="חסימה חוזרת כל שבוע"
            hint="כל החסימות נקבעות עכשיו, באותו יום בשבוע ובאותן שעות."
            checked={repeat}
            onChange={(event) => setRepeat(event.target.checked)}
          />
          {repeat ? (
            <TextField
              label="כמה שבועות בסך הכול"
              name="series_count"
              type="number"
              inputMode="numeric"
              min={SERIES_MIN}
              max={SERIES_MAX}
              required
              value={count}
              onChange={(event) => setCount(event.target.value)}
              hint={until ? `החסימה האחרונה: ${longDay(until)}` : `בין ${SERIES_MIN} ל-${SERIES_MAX}.`}
              error={errors.series_count}
            />
          ) : null}
        </div>
      )}
      {blockId && seriesIndex ? (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{blockSeriesLabel(seriesIndex)}. לשמור את השינויים ל:</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 has-checked:border-accent has-checked:bg-accent-soft">
              <input type="radio" name="series_scope" value="one" defaultChecked={values?.series_scope !== "following"} />
              החסימה הזו בלבד
            </label>
            <label className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 has-checked:border-accent has-checked:bg-accent-soft">
              <input type="radio" name="series_scope" value="following" defaultChecked={values?.series_scope === "following"} />
              החסימה הזו וכל הבאות
            </label>
          </div>
          <p className="mt-1.5 text-sm text-ink-soft">
            לחסימות הבאות עוברים התיאור והשעות, וכל אחת נשארת ביום שלה. בחירת יום אחר בשבוע מעבירה את כל הבאות ליום החדש, כסדרה חדשה.
          </p>
        </fieldset>
      ) : null}
      {split ? (
        <div role="alert" className="space-y-2.5 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-warning">
          <p className="font-semibold">{split.text}</p>
          {restDays ? <ConflictWarning report={{ people: [], restDays }} span={NO_SPAN} timeZone={timeZone} heading="שימו לב, חלק מהימים הם ימי מנוחה:" /> : null}
          <SubmitButton name="split_ok" value="1" size="sm" pendingText="מעבירים…">
            להעביר את הסדרה
          </SubmitButton>
        </div>
      ) : restDays ? (
        <ConflictWarning report={{ people: [], restDays }} span={NO_SPAN} timeZone={timeZone} heading="שימו לב, חלק מהחסימות נופלות על ימי מנוחה:">
          <SubmitButton name="rest_ok" value="1" size="sm" pendingText="חוסמים…">
            לחסום בכל זאת
          </SubmitButton>
        </ConflictWarning>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {restDays || split ? null : <SubmitButton pendingText="שומרים…">{blockId ? "שמירה" : repeat ? "חסימת הסדרה" : "חסימת הזמן"}</SubmitButton>}
        <Button variant="ghost" onClick={() => onDone()}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

/** In the calendar's details window of a block: change it, or free the time (of a series: this one, or from here on). */
export function BlockEditor({
  orgId,
  blockId,
  seriesIndex,
  timeZone,
  initial,
  onDone,
}: {
  orgId: string;
  blockId: string;
  seriesIndex: number | null;
  timeZone: string;
  initial: BlockValues;
  onDone: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <BlockForm
        orgId={orgId}
        blockId={blockId}
        seriesIndex={seriesIndex}
        timeZone={timeZone}
        initial={initial}
        onDone={(message) => (message ? onDone(message) : setEditing(false))}
      />
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
        עריכה
      </Button>
      <ConfirmButton
        title={seriesIndex ? "לשחרר את החסימה הזו?" : "לשחרר את הזמן החסום?"}
        description={seriesIndex ? "רק החסימה הזו תשוחרר. החסימות האחרות בסדרה נשארות." : "הזמן יחזור להיות פנוי, גם בדף קביעת התור."}
        confirmLabel="שחרור הזמן"
        action={() => deleteBlockAction(orgId, blockId)}
        onDone={() => onDone("הזמן שוחרר.")}
      >
        {seriesIndex ? "שחרור החסימה הזו" : "שחרור הזמן"}
      </ConfirmButton>
      {seriesIndex ? <ReleaseFollowingButton orgId={orgId} blockId={blockId} onDone={onDone} /> : null}
    </div>
  );
}

/** "שחרור החסימה הזו וכל הבאות": counts first, then each block goes by its own rights. */
function ReleaseFollowingButton({ orgId, blockId, onDone }: { orgId: string; blockId: string; onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<{ count: number; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function ask() {
    setError(null);
    setInfo(null);
    setOpen(true);
    startTransition(async () => {
      const answer = await releaseFollowingCountAction(orgId, blockId);
      if (answer.ok && answer.data) setInfo(answer.data);
      else setError(answer.ok ? "לא מצאנו את החסימות." : answer.message);
    });
  }

  function release() {
    startTransition(async () => {
      const answer = await releaseFollowingBlocksAction(orgId, blockId);
      if (!answer.ok) {
        setError(answer.message);
        return;
      }
      setOpen(false);
      onDone(answer.message ?? "החסימות שוחררו.");
    });
  }

  return (
    <>
      <Button variant="danger-ghost" size="sm" onClick={ask}>
        שחרור החסימה הזו וכל הבאות
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="לשחרר את החסימה הזו וכל הבאות?">
        <div className="space-y-4">
          {info === null && !error ? (
            <p role="status" className="text-sm text-ink-soft">
              סופרים את החסימות…
            </p>
          ) : null}
          {info ? <p className="text-md">{info.text}</p> : null}
          <FormError message={error} />
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onClick={release} disabled={!info || info.count === 0 || pending} loading={pending && info !== null}>
              {info && info.count > 1 ? `שחרור ${info.count} חסימות` : "שחרור"}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              ביטול
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
