"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { DisqualifyReasonField } from "@/features/disqualify-reasons/components/reason-field";

import { dropLeadAction } from "../actions";
import type { LeadStatusOption } from "../queries";

type Props = { orgId: string; leadId: string; leadName: string; currentStatusId: string; statuses: LeadStatusOption[]; reasons: string[] };

/**
 * Per-card status menu on the leads board: pick a status, then confirm. Works
 * with keyboard and touch alike. "Not relevant" asks for the reason first.
 * The board remounts the card (key) after a move.
 */
export function LeadStatusMenu({ orgId, leadId, leadName, currentStatusId, statuses, reasons }: Props) {
  const [selected, setSelected] = useState(currentStatusId);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const changed = selected !== currentStatusId;
  const needsReason = statuses.find((s) => s.id === selected)?.kind === "disqualified";

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await dropLeadAction(orgId, leadId, selected, needsReason ? reason : null);
      if (!result.ok) setError(result.message);
    });
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-end gap-2">
        <SelectField
          label={`סטטוס של הליד ${leadName}`}
          hideLabel
          controlSize="sm"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="min-w-0 flex-1"
        >
          {statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </SelectField>
        {changed ? (
          <Button size="sm" onClick={save} disabled={pending || (needsReason && !reason.trim())} aria-busy={pending || undefined}>
            {pending ? "מעבירים…" : "העברה"}
          </Button>
        ) : null}
      </div>
      {changed && needsReason ? (
        <DisqualifyReasonField reasons={reasons} label={`למה הליד ${leadName} לא רלוונטי?`} controlSize="sm" value={reason} onChange={setReason} />
      ) : null}
      <FormError message={error} />
    </div>
  );
}
