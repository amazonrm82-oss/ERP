"use client";

import { useState } from "react";

import { buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";

import type { ReportFilter } from "../definitions";
import { PERIOD_OPTIONS } from "../period";

type Option = { value: string; label: string };

type Props = {
  filters: ReportFilter[];
  period: { key: string; fromDate: string; toDate: string };
  ownerId: string;
  owners: Option[];
  pipelineId: string;
  pipelines: Option[];
  // what "no pipeline chosen" means for this report
  pipelineEmptyLabel: string;
};

/** A plain GET form: the filters live in the URL, so a report can be bookmarked or shared. */
export function ReportFilters({ filters, period, ownerId, owners, pipelineId, pipelines, pipelineEmptyLabel }: Props) {
  const [periodKey, setPeriodKey] = useState(period.key);
  return (
    <form method="get" className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4" aria-label="סינון הדוח">
      {filters.includes("period") ? (
        <>
          <SelectField label="תקופה" name="period" value={periodKey} onChange={(e) => setPeriodKey(e.target.value)} className="w-44">
            {PERIOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
          {periodKey === "custom" ? (
            <>
              <TextField label="מתאריך" name="from" type="date" defaultValue={period.fromDate} className="w-40" required />
              <TextField label="עד תאריך" name="to" type="date" defaultValue={period.toDate} className="w-40" required />
            </>
          ) : null}
        </>
      ) : null}
      {filters.includes("owner") ? (
        <SelectField label="נציג" name="owner" defaultValue={ownerId} className="w-44">
          <option value="">כל הנציגים</option>
          {owners.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      ) : null}
      {filters.includes("pipeline") && pipelines.length > 1 ? (
        <SelectField label="פייפליין" name="pipeline" defaultValue={pipelineId} className="w-44">
          <option value="">{pipelineEmptyLabel}</option>
          {pipelines.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      ) : null}
      <button type="submit" className={buttonClasses("secondary", "md")}>
        הצגה
      </button>
    </form>
  );
}
