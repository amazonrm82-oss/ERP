"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { inlineEditAction } from "@/features/inline-edit/actions";
import { RecordTaskForm } from "@/features/tasks/components/record-task-form";
import { WhatsappButton } from "@/features/whatsapp/components/whatsapp-button";
import type { TemplateValues } from "@/features/whatsapp/templates";

import { ROW_ACTION_LABELS, type RowAction } from "../row-actions";

export type RowActionTarget = {
  kind: "lead" | "deal" | "contact" | "company";
  id: string;
  name: string;
  ownerId: string | null;
  // where WhatsApp goes (the lead, the contact, or the deal's contact) and what a template's placeholders become
  phoneE164: string | null;
  values: TemplateValues;
  // the person the message goes to, for the window's title
  personName: string;
};

type Props = {
  orgId: string;
  target: RowActionTarget;
  // rowActions(): the best first
  actions: RowAction[];
  // who a record can be handed to: active members who write
  owners: { value: string; label: string }[];
};

/**
 * MNY-02: the actions of one row of "כסף שמחכה": the one that fits best first, as the main
 * button, then the others. A task on the record (FXU-01 form), handing it to a rep (the
 * list's owner edit, LST-06), or a WhatsApp message with a template (WA-01, logged on the
 * timeline). All with the user's session; the database decides.
 */
export function RowActions({ orgId, target, actions, owners }: Props) {
  const [open, setOpen] = useState<"task" | "assign" | null>(null);
  if (actions.length === 0) return null;
  // the best action looks primary; WhatsappButton has no primary look, so when WhatsApp comes
  // first the primary style goes to the next action
  const primary = actions.find((action) => action !== "whatsapp");

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {actions.map((action) =>
        action === "whatsapp" && target.phoneE164 ? (
          <WhatsappButton
            key={action}
            orgId={orgId}
            phoneE164={target.phoneE164}
            subject={{ kind: target.kind, id: target.id }}
            name={target.personName}
            values={target.values}
          />
        ) : action === "whatsapp" ? null : (
          <Button
            key={action}
            size="sm"
            variant={action === primary ? "primary" : "secondary"}
            aria-label={`${ROW_ACTION_LABELS[action]}: ${target.name}`}
            aria-haspopup="dialog"
            onClick={() => setOpen(action)}
          >
            {ROW_ACTION_LABELS[action]}
          </Button>
        ),
      )}
      <Dialog open={open === "task"} onClose={() => setOpen(null)} title="משימה חדשה" description={target.name} variant="sheet">
        {open === "task" ? <RecordTaskForm orgId={orgId} subject={{ kind: target.kind, id: target.id }} /> : null}
      </Dialog>
      <Dialog open={open === "assign"} onClose={() => setOpen(null)} title="הקצאה לנציג" description={target.name} variant="sheet">
        {open === "assign" ? <AssignForm orgId={orgId} target={target} owners={owners} onDone={() => setOpen(null)} onCancel={() => setOpen(null)} /> : null}
      </Dialog>
    </div>
  );
}

function AssignForm({
  orgId,
  target,
  owners,
  onDone,
  onCancel,
}: {
  orgId: string;
  target: RowActionTarget;
  owners: { value: string; label: string }[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [ownerId, setOwnerId] = useState(target.ownerId ?? owners[0]?.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        start(async () => {
          // the same owner change as a list's cell (0 rows = not permitted)
          const result = await inlineEditAction(orgId, target.kind, target.id, "owner", { id: ownerId || null });
          if (result.ok) {
            onDone();
            router.refresh();
          } else {
            setError(result.message);
          }
        });
      }}
    >
      <SelectField label="אחראי" value={ownerId} onChange={(event) => setOwnerId(event.target.value)} required autoFocus>
        {owners.map((owner) => (
          <option key={owner.value} value={owner.value}>
            {owner.label}
          </option>
        ))}
      </SelectField>
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || !ownerId}>
          {pending ? "שומרים…" : "הקצאה"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
