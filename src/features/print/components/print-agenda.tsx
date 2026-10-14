import type { CalendarEntry } from "@/features/calendar/components/calendar-board";
import { itemsOnDay } from "@/features/calendar/range";
import { longDay } from "@/lib/calendar-grid";

import { printTimeText } from "../print";

type Props = {
  // what the screen shows above the board: "יום שלישי, 14 באוקטובר 2026", or the week
  title: string;
  days: string[];
  // exactly the items the board got, read with the user's session
  items: CalendarEntry[];
  timeZone: string;
  // side-by-side view: the names of the shown people, to say whose each item is
  peopleNames?: Record<string, string>;
};

/**
 * GAP-11: the calendar on paper. The board is a screen tool (a time grid that scrolls, items that
 * are buttons), so the printout is a plain list of the same items, by day. Hidden on screen.
 */
export function PrintAgenda({ title, days, items, timeZone, peopleNames }: Props) {
  const filled = days.map((day) => ({ day, onDay: itemsOnDay(items, day, timeZone) })).filter((entry) => entry.onDay.length > 0);
  return (
    <section aria-label="סדר היום להדפסה" className="hidden print:block">
      <h2 className="mb-3 text-lead font-semibold">{title}</h2>
      {filled.length === 0 ? (
        <p className="text-md">אין פגישות או משימות בימים האלה.</p>
      ) : (
        filled.map(({ day, onDay }) => (
          <div key={day} className="mb-4">
            {days.length > 1 ? <h3 className="mb-1 border-b border-line pb-1 text-md font-semibold">{longDay(day)}</h3> : null}
            <ul className="divide-y divide-line">
              {onDay.map((item) => (
                <li key={`${item.kind}-${item.id}`} className="flex items-start gap-3 py-2">
                  <span className="w-28 shrink-0 text-sm tabular-nums" dir="ltr">
                    {printTimeText(item, timeZone)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={item.closed ? "block break-words font-medium line-through" : "block break-words font-medium"}>{item.title}</span>
                    <span className="block text-sm text-ink-soft">
                      {[item.kindLabel, item.typeLabel, item.statusLabel, item.ownerName].filter(Boolean).join(" · ")}
                    </span>
                    {item.location ? (
                      <span className="block text-sm text-ink-soft">
                        מקום: <bdi className="break-words">{item.location}</bdi>
                      </span>
                    ) : null}
                    {peopleNames && item.people.some((id) => peopleNames[id]) ? (
                      <span className="block text-sm text-ink-soft">
                        של: {item.people.flatMap((id) => (peopleNames[id] ? [peopleNames[id]] : [])).join(", ")}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
