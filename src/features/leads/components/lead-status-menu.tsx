"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { RequiredFieldsDialog, type RequiredAsk } from "@/features/custom-fields/components/required-fields-dialog";
import { isMoveRefusal } from "@/features/custom-fields/required-move";
import { DisqualifyReasonField } from "@/features/disqualify-reasons/components/reason-field";
import { moveAsk } from "@/features/record-move/ask";
import { moveRecordAction } from "@/features/record-move/actions";

import type { LeadStatusOption } from "../queries";

// onMoved: after a save (here or through the fields window), with the new status's name, for the board's announcement
type Props = {
  orgId: string;
  leadId: string;
  leadName: string;
  currentStatusId: string;
  statuses: LeadStatusOption[];
  reasons: string[];
  onMoved?: (statusName: string) => void;
};

/**
 * Per-card status menu on the leads board: pick a status, then confirm. Works
 * with keyboard and touch alike. "Not relevant" asks for the reason first.
 * The board remounts the card (key) after a move.
 */
export function LeadStatusMenu({ orgId, leadId, leadName, currentStatusId, statuses, reasons, onMoved }: Props) {
  const [selected, setSelected] = useState(currentStatusId);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [ask, setAsk] = useState<RequiredAsk | null>(null);
  const changed = selected !== currentStatusId;
  const needsReason = statuses.find((s) => s.id === selected)?.kind === "disqualified";

  function save() {
    setError(null);
    const statusId = selected;
    const why = needsReason ? reason.trim() || null : null;
    const status = statuses.find((s) => s.id === statusId);
    const moved = () => onMoved?.(status?.name ?? "");
    startTransition(async () => {
      const result = await moveRecordAction(orgId, "lead", leadId, statusId, why, null);
      if (result.ok) {
        moved();
        return;
      }
      if (isMoveRefusal(result)) {
        // FLD-09: the fields the status makes required are asked in the same window as on the board
        setAsk(
          moveAsk({
            orgId,
            object: "lead",
            id: leadId,
            targetId: statusId,
            description: `הליד ${leadName} עובר לסטטוס ${status?.name ?? ""}`,
            reason: why,
            reasons,
            reasonLabel: `למה הליד ${leadName} לא רלוונטי?`,
            refusal: result,
            onSaved: moved,
          }),
        );
      } else {
        setError(result.message);
      }
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
      <RequiredFieldsDialog ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}
