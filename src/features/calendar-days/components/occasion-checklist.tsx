"use client";

import { useState } from "react";

import { Checkbox } from "@/components/ui/field";

import { OCCASIONS, type OccasionKey } from "../holidays";

type Box = { key: OccasionKey; name: string; checked: boolean; disabled: boolean; note: string | null };

/**
 * The boxes of the occasion list (CAL-03: any occasion, holidays included, can be a rest day).
 * A holiday (or an eve) shows as checked and locked while its switch above already closes all of them;
 * otherwise it is checked when the business chose it on its own.
 */
export function occasionBoxes(holidaysRest: boolean, holidayEvesRest: boolean, chosen: ReadonlySet<OccasionKey>): Box[] {
  return OCCASIONS.map((occasion) => {
    const bySwitch = (occasion.kind === "rest" && holidaysRest) || (occasion.kind === "erev" && holidayEvesRest);
    return {
      key: occasion.key,
      name: occasion.name,
      checked: bySwitch || chosen.has(occasion.key),
      disabled: bySwitch,
      note: bySwitch ? (occasion.kind === "rest" ? "סגור לפי החגים למעלה" : "סגור לפי ערבי החג למעלה") : null,
    };
  });
}

type Props = {
  holidaysRest: boolean;
  holidayEvesRest: boolean;
  /** the occasions saved one by one */
  initial: readonly OccasionKey[];
};

/**
 * Every occasion of the list as a checkbox, sent as rest_occasions. A locked box (its switch is on) sends
 * its own choice through a hidden field, so turning the switch on and saving never loses what was picked.
 */
export function OccasionChecklist({ holidaysRest, holidayEvesRest, initial }: Props) {
  const [chosen, setChosen] = useState<ReadonlySet<OccasionKey>>(() => new Set(initial));
  const toggle = (key: OccasionKey, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {occasionBoxes(holidaysRest, holidayEvesRest, chosen).map((box) =>
        box.disabled ? (
          <div key={box.key} className="min-w-0">
            <Checkbox label={box.name} hint={box.note ?? undefined} checked readOnly disabled />
            {chosen.has(box.key) ? <input type="hidden" name="rest_occasions" value={box.key} /> : null}
          </div>
        ) : (
          <Checkbox
            key={box.key}
            className="min-w-0"
            name="rest_occasions"
            value={box.key}
            label={box.name}
            checked={box.checked}
            onChange={(event) => toggle(box.key, event.currentTarget.checked)}
          />
        ),
      )}
    </div>
  );
}
