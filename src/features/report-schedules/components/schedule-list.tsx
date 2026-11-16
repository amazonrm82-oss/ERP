"use client";

import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Switch } from "@/components/ui/field";

import { deleteReportScheduleAction, leaveReportScheduleAction, setReportScheduleEnabledAction } from "../actions";

export type ScheduleListItem = {
  id: string;
  title: string;
  periodText: string;
  whenText: string;
  recipientsText: string;
  enabled: boolean;
};

/** RPT-03: the schedules; owners and admins switch and remove them, a recipient takes themselves off. */
export function ScheduleList({ orgId, items, canManage }: { orgId: string; items: ScheduleListItem[]; canManage: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {item.title}
              {item.enabled ? null : <Badge>כבוי</Badge>}
            </p>
            <p className="text-sm text-ink-soft">
              {item.periodText} · {item.whenText}
            </p>
            <p className="text-sm text-ink-soft">נמענים: {item.recipientsText}</p>
          </div>
          {canManage ? (
            <span className="flex flex-wrap items-center gap-2">
              <EnabledSwitch orgId={orgId} id={item.id} enabled={item.enabled} title={item.title} />
              <ConfirmButton title="למחוק את הדוח המתוזמן?" description="הנמענים יפסיקו לקבל אותו." confirmLabel="מחיקה" action={deleteReportScheduleAction.bind(null, orgId, item.id)}>
                מחיקה<span className="sr-only">: {item.title}</span>
              </ConfirmButton>
            </span>
          ) : (
            <ConfirmButton title="להפסיק לקבל את הדוח הזה?" confirmLabel="הפסקה" action={leaveReportScheduleAction.bind(null, orgId, item.id)}>
              להפסיק לקבל<span className="sr-only">: {item.title}</span>
            </ConfirmButton>
          )}
        </li>
      ))}
    </ul>
  );
}

function EnabledSwitch({ orgId, id, enabled, title }: { orgId: string; id: string; enabled: boolean; title: string }) {
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="flex flex-col items-end gap-1">
      <Switch
        label={on ? "פעיל" : "כבוי"}
        aria-label={`${title}: ${on ? "פעיל" : "כבוי"}`}
        checked={on}
        disabled={pending}
        onCheckedChange={(next) => {
          setError(null);
          setOn(next);
          startTransition(async () => {
            const result = await setReportScheduleEnabledAction(orgId, id, next);
            if (!result.ok) {
              setOn(!next);
              setError(result.message);
            }
          });
        }}
      />
      {error ? (
        <span role="alert" className="max-w-56 text-end text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
