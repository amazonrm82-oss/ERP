"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { Button, IconButton } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { BackIcon, CalendarIcon, CheckSquareIcon, ForwardIcon } from "@/components/ui/icons";
import { HolidayLegend, HolidayMarks } from "@/features/calendar-days/components/holiday-marks";
import { ConflictWarning } from "@/features/meetings/components/conflict-warning";
import { MeetingItemButtons, type MeetingChange } from "@/features/meetings/components/meeting-buttons";
import type { MemberOption } from "@/features/meetings/components/meeting-form";
import { meetingFormTimes } from "@/features/meetings/display";
import type { ConflictReport, Span } from "@/features/meetings/conflicts";
import type { Holiday } from "@/features/calendar-days/holidays";
import { longDay, WEEKDAYS_LONG, WEEKDAYS_SHORT, weekday } from "@/lib/calendar-grid";
import { cn } from "@/lib/cn";
import { zoneDate, zonedIso, zoneTime } from "@/lib/format";

import { meetingDetailsAction, moveCalendarItemAction, type MeetingDetails } from "../actions";
import { LONG_PRESS_MS, pressDistance, pressOutcome } from "../long-press";
import {
  calendarPath,
  daySegments,
  itemsOnDay,
  minutesToTime,
  movedEnd,
  snapMinutes,
  wallMinutes,
  type CalendarQuery,
  type CalendarView,
  type Segment,
  type TimedItem,
} from "../range";
import { itemsByPerson, type CalendarPerson } from "../team";

/** One meeting or task as the screen shows it (labels made on the server). */
export type CalendarEntry = TimedItem & {
  title: string;
  // "פגישה" / "משימה"
  kindLabel: string;
  typeLabel: string;
  statusLabel: string;
  // a held/cancelled meeting or a done task is drawn quieter
  closed: boolean;
  ownerName: string | null;
  location: string | null;
  related: { href: string; label: string } | null;
  // CAL-04: the shown people it belongs to (side-by-side view)
  people: string[];
};

type Props = {
  orgId: string;
  view: CalendarView;
  // the day the URL names, and the days the view shows
  focusDay: string;
  days: string[];
  today: string;
  items: CalendarEntry[];
  timeZone: string;
  // UI hint: the database decides who may move what
  canMove: boolean;
  // whose calendar (the "who" and "team" of the URL) and `done`, kept on links
  scope: Pick<CalendarQuery, "who" | "team" | "done">;
  // the side-by-side view: a column per person (CAL-04)
  people: CalendarPerson[];
  // no view in the URL: a phone switches to the agenda
  autoView: boolean;
  // Israeli holidays of the shown days, by day (CAL-03)
  holidays: Record<string, Holiday[]>;
  // the active members, for the participants of the meeting form (writers only)
  members: MemberOption[];
};

type DragMode = "time" | "month";
type Drag = {
  item: CalendarEntry;
  mode: DragMode;
  // minutes between the item's start and the point where it was grabbed
  grabOffset: number;
  // the item's length on the grid, for the preview
  length: number;
  originalMinutes: number;
  startX: number;
  startY: number;
  // a finger: the drag starts after a long press (CAL-02), until then the page may scroll
  touch: boolean;
  // when the pointer came down (the event's timeStamp), for the long press
  startedAt: number;
  active: boolean;
  // `column` is the grid column dropped on (a day, or a person on the side-by-side view)
  target: { day: string; column: string; minutes: number } | null;
};

// what the calendar says after a meeting was changed from its window
const CHANGE_TEXT: Record<MeetingChange, string> = {
  edit: "הפגישה עודכנה.",
  status: "סטטוס הפגישה עודכן.",
  delete: "הפגישה נמחקה.",
};

// one hour on the time grid
const HOUR_CLASS = "h-12";
const FIRST_SHOWN_HOUR = 7;

/** The grid cell under a point while dragging, and the time or day it stands for. */
function targetAt(x: number, y: number, current: Drag): Drag["target"] {
  const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cal-day]");
  if (!cell || cell.dataset.calGrid !== current.mode || !cell.dataset.calDay) return null;
  const column = cell.dataset.calColumn ?? cell.dataset.calDay;
  if (current.mode === "month") return { day: cell.dataset.calDay, column, minutes: current.originalMinutes };
  const rect = cell.getBoundingClientRect();
  const offset = y - rect.top - (current.grabOffset / (24 * 60)) * rect.height;
  return { day: cell.dataset.calDay, column, minutes: snapMinutes(offset, rect.height) };
}

function timeText(item: TimedItem, timeZone: string): string {
  const start = zoneTime(new Date(item.startsAt), timeZone);
  return item.endsAt ? `${start}–${zoneTime(new Date(item.endsAt), timeZone)}` : start;
}

function whenText(item: TimedItem, timeZone: string): string {
  const start = new Date(item.startsAt);
  const startDay = zoneDate(start, timeZone);
  if (!item.endsAt) return `${longDay(startDay)}, ${zoneTime(start, timeZone)}`;
  const end = new Date(item.endsAt);
  const endDay = zoneDate(end, timeZone);
  const endText = endDay === startDay ? zoneTime(end, timeZone) : `${longDay(endDay)}, ${zoneTime(end, timeZone)}`;
  return `${longDay(startDay)}, ${zoneTime(start, timeZone)}–${endText}`;
}

function itemClasses(item: CalendarEntry): string {
  if (item.kind === "meeting") {
    return item.closed ? "border-s-4 border-line-strong bg-canvas text-ink-soft" : "border-s-4 border-accent bg-accent-soft text-accent-strong";
  }
  return cn("border border-line-strong bg-surface", item.closed ? "text-ink-soft line-through" : "text-ink");
}

/**
 * The calendar (CAL-02): a time grid for a day or a week, a month grid, and an
 * agenda list. Dragging an item with a mouse or a pen moves it (a quarter-hour
 * grid; on the month grid the day changes and the time stays); a finger drags
 * after a long press, so a swipe still scrolls and a tap still opens. Every
 * item is also a button that opens its details with a "move" form, so moving
 * works from the keyboard and with a screen reader.
 */
export function CalendarBoard({ orgId, view, focusDay, days, today, items, timeZone, canMove, scope, people, autoView, holidays, members }: Props) {
  const router = useRouter();
  const [shown, showMoved] = useOptimistic(items, (state, moved: { id: string; startsAt: string; endsAt: string | null }) =>
    state.map((item) => (item.id === moved.id ? { ...item, startsAt: moved.startsAt, endsAt: moved.endsAt } : item)),
  );
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // CAL-05: a move that clashes waits for "move anyway"
  const [conflict, setConflict] = useState<{ item: CalendarEntry; date: string; time: string; report: ConflictReport; span: Span } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  // the long-press timer of a finger on an item
  const pressTimer = useRef<number | null>(null);

  // a phone opens on the agenda unless the URL asks for a view
  useEffect(() => {
    if (autoView && window.matchMedia("(max-width: 639px)").matches) {
      router.replace(calendarPath(orgId, { view: "agenda", date: focusDay, ...scope }));
    }
  }, [autoView, focusDay, orgId, router, scope]);

  function move(item: CalendarEntry, date: string, time: string, confirmed = false) {
    const startsAt = zonedIso(date, `${time}:00`, timeZone);
    const endsAt = item.endsAt ? movedEnd(item.startsAt, item.endsAt, startsAt) : null;
    setStatus(null);
    setConflict(null);
    startTransition(async () => {
      showMoved({ id: item.id, startsAt, endsAt });
      const result = await moveCalendarItemAction(orgId, item.id, { kind: item.kind, date, time, ...(confirmed ? { confirmed } : {}) });
      if (result.ok) {
        setStatus({ tone: "ok", text: `"${item.title}" הועברה ל${whenText({ ...item, startsAt, endsAt }, timeZone)}.` });
      } else if (!result.ok && result.conflicts && result.span) {
        // nothing moved: the item goes back until the user says "move anyway"
        setConflict({ item, date, time, report: result.conflicts, span: result.span });
      } else {
        setStatus({ tone: "error", text: result.message });
      }
    });
  }

  // --- dragging (mouse and pen at once; a finger after a long press) ----------

  // the latest move(), for the window listeners below
  const moveRef = useRef(move);
  useEffect(() => {
    moveRef.current = move;
  });

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;

    function clearPress() {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }

    function finish(current: Drag | null, drop: boolean) {
      clearPress();
      dragRef.current = null;
      setDrag(null);
      if (!current?.active) return;
      // the click that ends a drag does not open the item
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (!drop || !current.target) return;
      const { day, minutes } = current.target;
      if (day === zoneDate(new Date(current.item.startsAt), timeZone) && minutes === current.originalMinutes) return;
      moveRef.current(current.item, day, minutesToTime(minutes));
    }

    function onPointerMove(event: PointerEvent) {
      const current = dragRef.current;
      if (!current) return;
      if (current.touch && !current.active) {
        // a finger that moves before the long press is scrolling: let it
        const distance = pressDistance({ x: current.startX, y: current.startY }, { x: event.clientX, y: event.clientY });
        if (pressOutcome(distance, event.timeStamp - current.startedAt) === "cancel") finish(current, false);
        return;
      }
      if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return;
      const next = { ...current, active: true, target: targetAt(event.clientX, event.clientY, current) };
      dragRef.current = next;
      setDrag(next);
    }
    const onPointerUp = () => finish(dragRef.current, true);
    const onCancel = () => finish(dragRef.current, false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(dragRef.current, false);
    };
    // once lifted, the finger drags the item instead of scrolling the page
    const onTouchMove = (event: TouchEvent) => {
      if (dragRef.current?.touch && dragRef.current.active && event.cancelable) event.preventDefault();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("touchmove", onTouchMove);
      clearPress();
    };
  }, [dragging, timeZone]);

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>, item: CalendarEntry, mode: DragMode, segment?: Segment<CalendarEntry>) {
    if (!canMove || event.button !== 0) return;
    // a long meeting is moved by its first day
    if (segment && !segment.startsHere) return;
    const originalMinutes = wallMinutes(new Date(item.startsAt), timeZone);
    let grabOffset = 0;
    if (mode === "time" && segment) {
      const column = event.currentTarget.closest<HTMLElement>("[data-cal-day]");
      if (column) {
        const rect = column.getBoundingClientRect();
        grabOffset = ((event.clientY - rect.top) / rect.height) * 24 * 60 - segment.startMin;
      }
    }
    const length = segment ? segment.endMin - segment.startMin : 30;
    const touch = event.pointerType === "touch";
    const pending: Drag = {
      item,
      mode,
      grabOffset,
      length,
      originalMinutes,
      startX: event.clientX,
      startY: event.clientY,
      touch,
      startedAt: event.timeStamp,
      active: false,
      target: null,
    };
    dragRef.current = pending;
    setDrag(pending);
    if (!touch) return;
    // a finger lifts the item after resting on it (a tap opens it, a swipe scrolls)
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      const current = dragRef.current;
      if (current !== pending) return;
      const lifted: Drag = { ...current, active: true, target: targetAt(current.startX, current.startY, current) };
      dragRef.current = lifted;
      setDrag(lifted);
      if (typeof navigator.vibrate === "function") navigator.vibrate(15);
    }, LONG_PRESS_MS);
  }

  function open(item: CalendarEntry) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setOpenId(item.id);
  }

  const opened = shown.find((item) => item.id === openId) ?? null;
  const dayHref = (day: string) => calendarPath(orgId, { view: "day", date: day, ...scope });
  const dayColumns = (): TimeColumn[] =>
    days.map((day) => ({
      key: day,
      day,
      label: longDay(day),
      heading: (
        <>
          <DayHeading day={day} today={today} href={dayHref(day)} short={days.length > 1} />
          <HolidayMarks holidays={holidays[day] ?? []} compact={days.length > 1} className="mt-0.5" />
        </>
      ),
      items: shown,
    }));

  const itemButton = (item: CalendarEntry, mode: DragMode | null, extra: { className?: string; style?: CSSProperties; segment?: Segment<CalendarEntry>; compact?: boolean }) => (
    <button
      key={`${item.kind}-${item.id}`}
      type="button"
      onClick={() => open(item)}
      onPointerDown={mode ? (event) => startDrag(event, item, mode, extra.segment) : undefined}
      // a long press must not open the phone's own menu
      onContextMenu={mode && canMove ? (event) => event.preventDefault() : undefined}
      style={extra.style}
      className={cn(
        "block w-full min-w-0 overflow-hidden rounded px-1.5 text-start text-caption leading-snug select-none",
        itemClasses(item),
        canMove && mode && "cursor-grab [-webkit-touch-callout:none]",
        drag?.active && drag.item.id === item.id && (drag.touch ? "touch-none opacity-70 shadow-lg ring-2 ring-accent" : "opacity-60"),
        extra.className,
      )}
    >
      <span className="sr-only">{item.kindLabel}: </span>
      {item.kind === "task" ? <CheckSquareIcon aria-hidden="true" className="me-1 inline size-3.5 align-[-2px]" /> : null}
      <span className="tabular-nums">{zoneTime(new Date(item.startsAt), timeZone)}</span> <span className="font-medium">{item.title}</span>
      {extra.compact ? null : item.location ? <span className="block truncate">{item.location}</span> : null}
    </button>
  );

  return (
    <div>
      <div aria-live="polite" role="status" className="empty:hidden">
        {status ? (
          <p className={cn("mb-3 rounded-md px-3 py-2.5 text-sm", status.tone === "ok" ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>{status.text}</p>
        ) : null}
      </div>

      {conflict ? (
        <ConflictWarning
          report={conflict.report}
          span={conflict.span}
          timeZone={timeZone}
          heading={`שימו לב, במועד החדש של "${conflict.item.title}" יש התנגשות:`}
          className="mb-3"
        >
          <Button size="sm" onClick={() => move(conflict.item, conflict.date, conflict.time, true)}>
            להעביר בכל זאת
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>
            לא להעביר
          </Button>
        </ConflictWarning>
      ) : null}

      {view === "people" ? (
        <PeopleView day={focusDay} people={people} items={shown} timeZone={timeZone} drag={drag} itemButton={itemButton} holidays={holidays} dayHref={dayHref} onOpen={open} today={today} />
      ) : view === "month" ? (
        <MonthGrid days={days} focusDay={focusDay} today={today} items={shown} timeZone={timeZone} dayHref={dayHref} drag={drag} itemButton={itemButton} holidays={holidays} />
      ) : view === "agenda" ? (
        <AgendaList days={days} today={today} items={shown} timeZone={timeZone} dayHref={dayHref} onOpen={open} holidays={holidays} />
      ) : view === "week" ? (
        <>
          <div className="hidden sm:block">
            <TimeGrid columns={dayColumns()} timeZone={timeZone} drag={drag} itemButton={itemButton} />
          </div>
          {/* seven columns do not fit a phone: the week is a list there */}
          <div className="sm:hidden">
            <AgendaList days={days} today={today} items={shown} timeZone={timeZone} dayHref={dayHref} onOpen={open} holidays={holidays} />
          </div>
        </>
      ) : (
        <TimeGrid columns={dayColumns()} timeZone={timeZone} drag={drag} itemButton={itemButton} />
      )}

      {days.some((day) => holidays[day]?.length) ? <HolidayLegend className="mt-3" /> : null}

      {canMove ? (
        <p className="mt-3 text-sm text-ink-soft">אפשר לגרור פגישה או משימה למועד אחר (במסך מגע: לחיצה ארוכה ואז גרירה), או ללחוץ עליה ולבחור &quot;העברה&quot;.</p>
      ) : null}

      <Dialog open={opened !== null} onClose={() => setOpenId(null)} title={opened?.title ?? ""} description={opened?.kindLabel} variant="sheet">
        {opened ? (
          <ItemDetails
            key={`${opened.id}-${opened.startsAt}`}
            orgId={orgId}
            item={opened}
            timeZone={timeZone}
            canMove={canMove}
            members={members}
            onMove={(date, time) => {
              setOpenId(null);
              move(opened, date, time);
            }}
            onChanged={(change, message) => {
              setOpenId(null);
              setStatus(message ? { tone: "error", text: message } : { tone: "ok", text: CHANGE_TEXT[change] });
            }}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

type ItemButton = (
  item: CalendarEntry,
  mode: DragMode | null,
  extra: { className?: string; style?: CSSProperties; segment?: Segment<CalendarEntry>; compact?: boolean },
) => ReactNode;

type GridProps = {
  days: string[];
  today: string;
  items: CalendarEntry[];
  timeZone: string;
  dayHref: (day: string) => string;
  drag: Drag | null;
  itemButton: ItemButton;
  holidays: Record<string, Holiday[]>;
};

function DayHeading({ day, today, href, short }: { day: string; today: string; href: string; short?: boolean }) {
  const names = short ? WEEKDAYS_SHORT : WEEKDAYS_LONG;
  return (
    <Link
      href={href}
      aria-label={longDay(day)}
      aria-current={day === today ? "date" : undefined}
      className={cn("flex flex-col items-center rounded-md px-1 py-1.5 text-sm hover:bg-canvas", day === today && "bg-accent-soft text-accent-strong")}
    >
      <span className={cn(day === today ? "text-accent-strong" : "text-ink-soft")}>{names[weekday(day)]}</span>
      <span className="text-lead font-semibold tabular-nums">{Number(day.slice(8, 10))}</span>
    </Link>
  );
}

/** One column of the time grid: a day, or one person on one day (CAL-04). */
type TimeColumn = {
  key: string;
  day: string;
  // the column's name for a screen reader
  label: string;
  heading: ReactNode;
  // the items to place; only the ones on `day` are shown
  items: CalendarEntry[];
};

/**
 * Day, week or side by side: a column per day or per person, 24 rows of an
 * hour, items placed by wall-clock time. `minColumn` keeps person columns
 * readable; the grid then scrolls sideways inside its own box.
 */
function TimeGrid({ columns, timeZone, drag, itemButton, minColumn }: { columns: TimeColumn[]; timeZone: string; drag: Drag | null; itemButton: ItemButton; minColumn?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const template = { gridTemplateColumns: `3.5rem repeat(${columns.length}, minmax(${minColumn ?? "0"}, 1fr))` };
  const segmentsByColumn = columns.map((column) => daySegments(column.items, column.day, timeZone));
  const earliest = Math.min(FIRST_SHOWN_HOUR * 60, ...segmentsByColumn.flat().map((s) => s.startMin));

  const columnsKey = columns.map((column) => `${column.key}@${column.day}`).join();
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    // once per set of columns, not again when an item moves
    if (!el || scrolledFor.current === columnsKey) return;
    scrolledFor.current = columnsKey;
    el.scrollTop = (el.scrollHeight * Math.max(0, earliest - 30)) / (24 * 60);
  }, [columnsKey, earliest]);

  return (
    <div className={cn("rounded-lg border border-line bg-surface", minColumn ? "overflow-x-auto" : "overflow-hidden")}>
      <div className={minColumn ? "min-w-max" : undefined}>
        <div className="grid border-b border-line" style={template}>
          <span aria-hidden="true" />
          {columns.map((column) => (
            <div key={column.key} className="min-w-0 border-s border-line p-1">
              {column.heading}
            </div>
          ))}
        </div>
        <div ref={scrollRef} className="max-h-[70dvh] overflow-y-auto">
          <div className="grid" style={template}>
            <div aria-hidden="true">
              {Array.from({ length: 24 }, (_, hour) => (
                <div key={hour} className={cn(HOUR_CLASS, "pe-2 text-end text-caption text-ink-soft tabular-nums")}>
                  <span className="relative -top-2">{hour === 0 ? "" : `${String(hour).padStart(2, "0")}:00`}</span>
                </div>
              ))}
            </div>
            {columns.map((column, index) => {
              const preview =
                drag?.active && drag.mode === "time" && drag.target?.column === column.key ? { minutes: drag.target.minutes, length: drag.length } : null;
              return (
                <div key={column.key} data-cal-day={column.day} data-cal-column={column.key} data-cal-grid="time" className="relative border-s border-line">
                  {Array.from({ length: 24 }, (_, hour) => (
                    <div key={hour} aria-hidden="true" className={cn(HOUR_CLASS, "border-b border-line")} />
                  ))}
                  <ul aria-label={column.label} className="absolute inset-0">
                    {segmentsByColumn[index].map((segment) => (
                      <li
                        key={`${segment.item.kind}-${segment.item.id}`}
                        className="absolute p-px"
                        style={{
                          top: `${(segment.startMin / 1440) * 100}%`,
                          height: `${((segment.endMin - segment.startMin) / 1440) * 100}%`,
                          insetInlineStart: `${(segment.column / segment.columns) * 100}%`,
                          width: `${100 / segment.columns}%`,
                        }}
                      >
                        {itemButton(segment.item, "time", { className: "h-full py-0.5", segment, compact: segment.endMin - segment.startMin < 45 })}
                      </li>
                    ))}
                  </ul>
                  {preview ? (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 rounded border-2 border-dashed border-accent bg-surface px-1 text-caption font-semibold text-accent-strong"
                      style={{ top: `${(preview.minutes / 1440) * 100}%`, height: `${(Math.max(preview.length, 15) / 1440) * 100}%` }}
                    >
                      {minutesToTime(preview.minutes)}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Side by side (CAL-04): one day, a column per person, with the items each one
 * organizes, takes part in or is assigned. A phone shows one person at a time,
 * with buttons and a list to move between them (spec 22.9).
 */
function PeopleView({
  day,
  today,
  people,
  items,
  timeZone,
  drag,
  itemButton,
  holidays,
  dayHref,
  onOpen,
}: {
  day: string;
  today: string;
  people: CalendarPerson[];
  items: CalendarEntry[];
  timeZone: string;
  drag: Drag | null;
  itemButton: ItemButton;
  holidays: Record<string, Holiday[]>;
  dayHref: (day: string) => string;
  onOpen: (item: CalendarEntry) => void;
}) {
  const [current, setCurrent] = useState(0);
  if (people.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState icon={<CalendarIcon />} title="אין את מי להציג" description="בחרו אנשים או צוות אחר." />
      </div>
    );
  }
  const byPerson = itemsByPerson(items, people);
  const countOnDay = (id: string) => itemsOnDay(byPerson.get(id) ?? [], day, timeZone).length;
  const index = Math.min(current, people.length - 1);
  const person = people[index];
  const columns: TimeColumn[] = people.map((p) => {
    const count = countOnDay(p.id);
    return {
      key: p.id,
      day,
      label: `${p.name}, ${longDay(day)}`,
      heading: (
        <div className="px-1 py-1.5 text-center">
          <span className="block truncate text-sm font-semibold" title={p.name}>
            {p.name}
          </span>
          <span className="block text-caption text-ink-soft tabular-nums">{count === 1 ? "פריט אחד" : `${count} פריטים`}</span>
        </div>
      ),
      items: byPerson.get(p.id) ?? [],
    };
  });

  return (
    <>
      {holidays[day]?.length ? <HolidayMarks holidays={holidays[day]} className="mb-2" /> : null}
      <div className="hidden sm:block">
        <TimeGrid columns={columns} timeZone={timeZone} drag={drag} itemButton={itemButton} minColumn="9rem" />
      </div>
      <div className="space-y-3 sm:hidden">
        <div className="flex items-end gap-1">
          <IconButton variant="secondary" label="האדם הקודם" icon={<BackIcon className="size-5" />} onClick={() => setCurrent(Math.max(0, index - 1))} disabled={index === 0} />
          <SelectField label="היומן של" hideLabel value={person.id} onChange={(event) => setCurrent(Math.max(0, people.findIndex((p) => p.id === event.target.value)))} className="min-w-0 flex-1">
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({countOnDay(p.id)})
              </option>
            ))}
          </SelectField>
          <IconButton
            variant="secondary"
            label="האדם הבא"
            icon={<ForwardIcon className="size-5" />}
            onClick={() => setCurrent(Math.min(people.length - 1, index + 1))}
            disabled={index === people.length - 1}
          />
        </div>
        <p className="text-sm text-ink-soft" aria-live="polite">
          {person.name}, {index + 1} מתוך {people.length}
        </p>
        <AgendaList
          days={[day]}
          today={today}
          items={byPerson.get(person.id) ?? []}
          timeZone={timeZone}
          dayHref={dayHref}
          onOpen={onOpen}
          holidays={{}}
          emptyTitle={`אין ל${person.name} פגישות או משימות ביום הזה`}
        />
      </div>
    </>
  );
}

// a month cell shows this many items; the rest are behind "עוד"
const MONTH_CELL_ITEMS = 3;

/** A month: whole weeks from Sunday, a day's items in its cell, the day itself a link to its day view. */
function MonthGrid({ days, focusDay, today, items, timeZone, dayHref, drag, itemButton, holidays }: GridProps & { focusDay: string }) {
  const month = focusDay.slice(0, 7);
  const weeks = Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="grid grid-cols-7 border-b border-line" aria-hidden="true">
        {WEEKDAYS_LONG.map((name, i) => (
          <span key={name} className="py-1.5 text-center text-sm text-ink-soft">
            <span className="hidden sm:inline">{name}</span>
            <span className="sm:hidden">{WEEKDAYS_SHORT[i]}</span>
          </span>
        ))}
      </div>
      {weeks.map((week) => (
        <ul key={week[0]} className="grid grid-cols-7 border-b border-line last:border-b-0">
          {week.map((day) => {
            const onDay = itemsOnDay(items, day, timeZone);
            const outside = day.slice(0, 7) !== month;
            const target = drag?.active && drag.mode === "month" && drag.target?.day === day;
            const countText = onDay.length > 0 ? `, ${onDay.length} ${onDay.length === 1 ? "פריט" : "פריטים"}` : "";
            return (
              <li
                key={day}
                data-cal-day={day}
                data-cal-grid="month"
                className={cn("min-h-16 min-w-0 border-s border-line p-1 first:border-s-0 sm:min-h-28", outside && "bg-canvas", target && "outline-2 -outline-offset-2 outline-accent")}
              >
                <Link
                  href={dayHref(day)}
                  aria-label={`${longDay(day)}${countText}`}
                  aria-current={day === today ? "date" : undefined}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full text-sm tabular-nums hover:bg-canvas",
                    day === today ? "bg-accent text-on-accent hover:bg-accent-strong" : outside ? "text-ink-soft" : "text-ink",
                  )}
                >
                  {Number(day.slice(8, 10))}
                </Link>
                <HolidayMarks holidays={holidays[day] ?? []} compact className="mt-0.5" />
                {onDay.length > 0 ? (
                  <span aria-hidden="true" className="mt-0.5 block text-center text-caption font-semibold text-accent sm:hidden">
                    {onDay.length}
                  </span>
                ) : null}
                <ul className="mt-1 hidden space-y-0.5 sm:block">
                  {onDay.slice(0, MONTH_CELL_ITEMS).map((item) => (
                    <li key={`${item.kind}-${item.id}`}>
                      {itemButton(item, zoneDate(new Date(item.startsAt), timeZone) === day ? "month" : null, { className: "truncate py-0.5", compact: true })}
                    </li>
                  ))}
                  {onDay.length > MONTH_CELL_ITEMS ? (
                    <li>
                      <Link href={dayHref(day)} className="block px-1.5 text-caption font-medium text-accent hover:underline">
                        עוד {onDay.length - MONTH_CELL_ITEMS}
                      </Link>
                    </li>
                  ) : null}
                </ul>
              </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
}

/** The agenda: the days that have something, each with its items in time order. */
function AgendaList({
  days,
  today,
  items,
  timeZone,
  dayHref,
  onOpen,
  holidays,
  emptyTitle,
}: {
  days: string[];
  today: string;
  items: CalendarEntry[];
  timeZone: string;
  dayHref: (day: string) => string;
  onOpen: (item: CalendarEntry) => void;
  holidays: Record<string, Holiday[]>;
  emptyTitle?: string;
}) {
  const filled = days.map((day) => ({ day, onDay: itemsOnDay(items, day, timeZone) })).filter((entry) => entry.onDay.length > 0);
  if (filled.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState icon={<CalendarIcon />} title={emptyTitle ?? "אין פגישות או משימות בימים האלה"} description="פגישה קובעים מתוך הכרטיס של ליד, איש קשר, חברה או עסקה. משימה עם מועד מופיעה כאן לבד." />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {filled.map(({ day, onDay }) => (
        <section key={day} aria-labelledby={`agenda-${day}`} className="rounded-lg border border-line bg-surface">
          <h2 id={`agenda-${day}`} className="border-b border-line px-4 py-2.5 text-md font-semibold">
            <Link href={dayHref(day)} className="hover:underline">
              {longDay(day)}
            </Link>
            {day === today ? <span className="ms-2 rounded-full bg-accent-soft px-2 py-0.5 text-caption text-accent-strong">היום</span> : null}
          </h2>
          {holidays[day]?.length ? <HolidayMarks holidays={holidays[day]} className="px-4 pt-2" /> : null}
          <ul className="divide-y divide-line">
            {onDay.map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <button type="button" onClick={() => onOpen(item)} className="flex min-h-11 w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-canvas">
                  <span className="w-24 shrink-0 text-sm text-ink-soft tabular-nums" dir="ltr">
                    {timeText(item, timeZone)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block break-words font-medium", item.closed && "text-ink-soft line-through")}>
                      <span className="sr-only">{item.kindLabel}: </span>
                      {item.title}
                    </span>
                    <span className="block text-sm text-ink-soft">
                      {item.kindLabel} · {item.statusLabel}
                      {item.ownerName ? ` · ${item.ownerName}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * What the item is, a link to its record, and the "move" form. A meeting also
 * loads its details (CAL-01 follow-up: participants, video link, description,
 * outcome) with the same edit, status and delete buttons as the record cards,
 * so a meeting on no record can be changed from here. The buttons show to
 * writers; the database decides (0 rows = not permitted, with a message).
 */
function ItemDetails({
  orgId,
  item,
  timeZone,
  canMove,
  members,
  onMove,
  onChanged,
}: {
  orgId: string;
  item: CalendarEntry;
  timeZone: string;
  canMove: boolean;
  members: MemberOption[];
  onMove: (date: string, time: string) => void;
  onChanged: (change: MeetingChange, message?: string) => void;
}) {
  const start = new Date(item.startsAt);
  const [date, setDate] = useState(zoneDate(start, timeZone));
  const [time, setTime] = useState(zoneTime(start, timeZone));
  const [error, setError] = useState<string | null>(null);
  // a meeting's details: loading, loaded, or why not
  const [details, setDetails] = useState<{ meeting: MeetingDetails } | { error: string } | null>(null);

  useEffect(() => {
    if (item.kind !== "meeting") return;
    let live = true;
    meetingDetailsAction(orgId, item.id).then(
      (result) => {
        if (live) setDetails(result.ok && result.meeting ? { meeting: result.meeting } : { error: result.ok ? "לא מצאנו את הפגישה." : result.message });
      },
      () => {
        if (live) setDetails({ error: "לא הצלחנו לטעון את פרטי הפגישה. נסו שוב." });
      },
    );
    return () => {
      live = false;
    };
  }, [orgId, item.id, item.kind]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!date) return setError("יש לבחור תאריך.");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return setError("יש לבחור שעה.");
    onMove(date, time);
  }

  const meeting = details && "meeting" in details ? details.meeting : null;

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-md">
        <dt className="text-ink-soft">מתי</dt>
        <dd>{whenText(item, timeZone)}</dd>
        <dt className="text-ink-soft">סוג</dt>
        <dd>{item.typeLabel}</dd>
        <dt className="text-ink-soft">סטטוס</dt>
        <dd>{item.statusLabel}</dd>
        {item.ownerName ? (
          <>
            <dt className="text-ink-soft">{item.kind === "meeting" ? "מארגן" : "אחראי"}</dt>
            <dd>{item.ownerName}</dd>
          </>
        ) : null}
        {item.location ? (
          <>
            <dt className="text-ink-soft">מיקום</dt>
            <dd className="break-words">{item.location}</dd>
          </>
        ) : null}
        {meeting && meeting.participants.length > 0 ? (
          <>
            <dt className="text-ink-soft">משתתפים</dt>
            <dd className="break-words">{meeting.participants.map((p) => p.name).join(", ")}</dd>
          </>
        ) : null}
      </dl>
      {item.kind === "meeting" ? (
        details === null ? (
          <p role="status" className="text-sm text-ink-soft">
            טוענים את פרטי הפגישה…
          </p>
        ) : "error" in details ? (
          <p role="alert" className="text-sm text-danger">
            {details.error}
          </p>
        ) : null
      ) : null}
      {meeting?.videoUrl ? (
        <p className="text-md">
          <a href={meeting.videoUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong">
            כניסה לשיחת הווידאו
          </a>
        </p>
      ) : null}
      {meeting?.description ? <p className="whitespace-pre-line break-words text-md">{meeting.description}</p> : null}
      {meeting?.outcome ? (
        <p className="whitespace-pre-line break-words rounded-md bg-canvas px-3 py-2 text-md">
          <span className="font-medium">תוצאה: </span>
          {meeting.outcome}
        </p>
      ) : null}
      {item.related ? (
        <p>
          <Link href={item.related.href} className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong">
            {item.related.label}
          </Link>
        </p>
      ) : null}
      {meeting && canMove ? (
        <MeetingItemButtons
          orgId={orgId}
          subject={meeting.subject}
          members={members}
          timeZone={timeZone}
          meetingId={meeting.id}
          title={meeting.title}
          status={meeting.status}
          outcome={meeting.outcome ?? ""}
          initial={{
            title: meeting.title,
            meeting_type: meeting.meetingType,
            ...meetingFormTimes(meeting.startsAt, meeting.endsAt, timeZone),
            location: meeting.location ?? "",
            video_url: meeting.videoUrl ?? "",
            description: meeting.description ?? "",
            participant_ids: meeting.participants.map((p) => p.userId),
          }}
          onChanged={onChanged}
        />
      ) : null}
      {canMove ? (
        <form onSubmit={submit} noValidate className="space-y-3 border-t border-line pt-4">
          <h3 className="text-md font-semibold">העברה למועד אחר</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <DateField label="תאריך" value={date} onChange={setDate} required timeZone={timeZone} />
            <TextField label="שעה" type="time" required value={time} onChange={(event) => setTime(event.target.value)} />
          </div>
          {item.kind === "meeting" ? <p className="text-sm text-ink-soft">משך הפגישה נשמר.</p> : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit">העברה</Button>
        </form>
      ) : null}
    </div>
  );
}
