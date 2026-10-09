import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { SelectField } from "@/components/ui/field";

import type { BoardFilter } from "../queries";

type Option = { value: string; label: string };

type Props = {
  action: string;
  // the board's other settings, kept when the filter changes
  keep: Record<string, string>;
  filter: BoardFilter & { owner: string | null };
  owners: Option[];
  teams: Option[];
  tags: Option[];
  clearHref: string | null;
  timeZone: string;
};

/** Narrow the board by owner, team, expected close date and tag (DEAL-09). A plain GET form. */
export function BoardFilters({ action, keep, filter, owners, teams, tags, clearHref, timeZone }: Props) {
  return (
    <details className="mb-4 rounded-lg border border-line bg-surface" open={clearHref !== null}>
      <summary className="cursor-pointer px-4 py-2.5 text-md font-medium">{clearHref ? "סינון הלוח (פעיל)" : "סינון הלוח"}</summary>
      <form method="get" action={action} className="flex flex-wrap items-end gap-3 border-t border-line px-4 py-3">
        {Object.entries(keep).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <SelectField label="אחראי" name="owner" defaultValue={filter.owner ?? ""} className="w-44">
          <option value="">כולם</option>
          <option value="me">אני</option>
          {owners.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        {teams.length > 0 ? (
          <SelectField label="צוות" name="team" defaultValue={filter.teamId ?? ""} className="w-40">
            <option value="">כל הצוותים</option>
            {teams.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
        ) : null}
        {tags.length > 0 ? (
          <SelectField label="תגית" name="tag" defaultValue={filter.tagId ?? ""} className="w-40">
            <option value="">כל התגיות</option>
            {tags.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
        ) : null}
        <DateField label="תאריך סגירה צפוי מ-" name="close_from" defaultValue={filter.closeFrom ?? ""} timeZone={timeZone} className="w-44" />
        <DateField label="עד" name="close_to" defaultValue={filter.closeTo ?? ""} timeZone={timeZone} className="w-44" />
        <div className="flex gap-2">
          <button type="submit" className={buttonClasses("secondary", "md")}>
            סינון
          </button>
          {clearHref ? (
            <Link href={clearHref} className={buttonClasses("ghost", "md")}>
              ניקוי הסינון
            </Link>
          ) : null}
        </div>
      </form>
    </details>
  );
}
