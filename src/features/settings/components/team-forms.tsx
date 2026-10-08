"use client";

import { useActionState, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { TrashIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import {
  addTeamMemberAction,
  createTeamAction,
  deleteTeamAction,
  removeTeamMemberAction,
  renameTeamAction,
  setTeamManagerAction,
} from "../actions";
import type { TeamDetails } from "../queries";

export function CreateTeamForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(createTeamAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
      <TextField
        label="שם הצוות"
        name="name"
        required
        maxLength={80}
        autoComplete="off"
        className="flex-1"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
      />
      <SubmitButton className="sm:mt-6.5" pendingText="יוצר…">
        יצירת צוות
      </SubmitButton>
    </form>
  );
}

export function RenameTeamForm({ orgId, team }: { orgId: string; team: { id: string; name: string } }) {
  const [state, formAction] = useActionState<FormState, FormData>(renameTeamAction.bind(null, orgId, team.id), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <TextField
          label="שם הצוות"
          name="name"
          required
          maxLength={80}
          autoComplete="off"
          className="flex-1"
          defaultValue={failure?.values?.name ?? team.name}
          error={failure?.fieldErrors?.name}
        />
        <SubmitButton className="sm:mt-6.5">שמירה</SubmitButton>
      </div>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
    </form>
  );
}

type Candidate = { userId: string; name: string };

export function AddTeamMemberForm({ orgId, teamId, candidates }: { orgId: string; teamId: string; candidates: Candidate[] }) {
  const [state, formAction] = useActionState<FormState, FormData>(addTeamMemberAction.bind(null, orgId, teamId), null);
  const failure = state && !state.ok ? state : null;

  if (candidates.length === 0) {
    return <p className="text-md text-ink-soft">כל המשתמשים הפעילים כבר בצוות.</p>;
  }

  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <SelectField label="משתמש" name="user_id" defaultValue="" error={failure?.fieldErrors?.user_id}>
        <option value="" disabled>
          בחירת משתמש
        </option>
        {candidates.map((candidate) => (
          <option key={candidate.userId} value={candidate.userId}>
            {candidate.name}
          </option>
        ))}
      </SelectField>
      <label className="flex items-start gap-2 text-md">
        <input type="checkbox" name="is_manager" className="mt-1 size-4 accent-accent" />
        <span>מנהל הצוות (רואה ועורך את רשומות הצוות, אם התפקיד שלו &quot;מנהל צוות&quot;)</span>
      </label>
      <SubmitButton size="sm" pendingText="מוסיף…">
        הוספה לצוות
      </SubmitButton>
    </form>
  );
}

type MembersProps = { orgId: string; teamId: string; members: TeamDetails["members"]; editable: boolean };

export function TeamMembersList({ orgId, teamId, members, editable }: MembersProps) {
  if (members.length === 0) {
    return <p className="px-4 py-6 text-center text-md text-ink-soft sm:px-5">אין עדיין משתמשים בצוות.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {members.map((member) => (
        <TeamMemberRow key={`${member.userId}-${member.isManager}`} orgId={orgId} teamId={teamId} member={member} editable={editable} />
      ))}
    </ul>
  );
}

function TeamMemberRow({
  orgId,
  teamId,
  member,
  editable,
}: {
  orgId: string;
  teamId: string;
  member: TeamDetails["members"][number];
  editable: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.message ?? null);
      }
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {member.name}
          {member.isManager ? <Badge tone="accent">מנהל הצוות</Badge> : null}
        </p>
        {member.email ? (
          <p dir="ltr" className="truncate text-end text-sm text-ink-soft sm:text-start">
            {member.email}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
      {editable ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => run(() => setTeamManagerAction(orgId, teamId, member.userId, !member.isManager))}
          >
            {member.isManager ? "ביטול ניהול" : "מינוי למנהל"}
            <span className="sr-only">: {member.name}</span>
          </Button>
          <Button
            variant="danger-ghost"
            size="sm"
            disabled={pending}
            onClick={() => run(() => removeTeamMemberAction(orgId, teamId, member.userId))}
          >
            הסרה
            <span className="sr-only">: {member.name}</span>
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function DeleteTeamButton({ orgId, teamId, teamName }: { orgId: string; teamId: string; teamName: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await deleteTeamAction(orgId, teamId);
      // only reached when the action did not redirect
      if (!result.ok) {
        setError(result.message);
      }
    });
  }

  if (!confirming) {
    return (
      <Button variant="danger-ghost" size="sm" onClick={() => setConfirming(true)}>
        <TrashIcon className="size-4.5" />
        מחיקת הצוות
      </Button>
    );
  }

  return (
    <div role="group" aria-labelledby="delete-team-title" className="rounded-lg border border-line bg-surface p-4">
      <p id="delete-team-title" className="font-medium">
        למחוק את הצוות &quot;{teamName}&quot;?
      </p>
      <p className="mt-1 text-sm text-ink-soft">
        המשתמשים לא נמחקים, והרשומות נשארות אצל הבעלים שלהן בלי שיוך לצוות. אי אפשר לבטל את המחיקה.
      </p>
      <FormError message={error} className="mt-3" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="danger" size="sm" onClick={confirm} disabled={pending} aria-busy={pending || undefined}>
          {pending ? "מוחק…" : "כן, למחוק"}
        </Button>
        <Button variant="secondary" size="sm" autoFocus onClick={() => setConfirming(false)} disabled={pending}>
          ביטול
        </Button>
      </div>
    </div>
  );
}
