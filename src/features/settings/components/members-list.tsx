"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { Select } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { ROLE_LABELS } from "@/features/shell/labels";
import type { FormState } from "@/lib/action-result";
import type { MembershipRole } from "@/lib/database.types";
import { paths } from "@/lib/paths";
import { submitWith } from "@/lib/use-submit";

import { changeMemberRoleAction, resetMemberMfaAction, setAvailabilityAction, setMemberStatusAction } from "../actions";
import { canManageMember, type InvitableRole } from "../permissions";
import type { Member } from "../queries";

type Props = {
  orgId: string;
  myUserId: string;
  myRole: MembershipRole;
  // roles the current user may assign; empty when they manage nobody
  roles: InvitableRole[];
  canWrite: boolean;
  members: Member[];
  // members with two-step verification on (known to owners and admins only)
  mfaUserIds?: string[];
};

export function MembersList({ orgId, myUserId, myRole, roles, canWrite, members, mfaUserIds = [] }: Props) {
  return (
    <ul className="divide-y divide-line">
      {members.map((member) => (
        <MemberRow
          // remount when the saved role or status changes, so the controls reset
          key={`${member.userId}-${member.role}-${member.status}-${member.isAvailable}`}
          orgId={orgId}
          member={member}
          isMe={member.userId === myUserId}
          manageable={canWrite && canManageMember(myRole, myUserId, member)}
          roles={roles}
          hasMfa={mfaUserIds.includes(member.userId)}
        />
      ))}
    </ul>
  );
}

type RowProps = { orgId: string; member: Member; isMe: boolean; manageable: boolean; roles: InvitableRole[]; hasMfa: boolean };

function MemberRow({ orgId, member, isMe, manageable, roles, hasMfa }: RowProps) {
  const suspended = member.status === "suspended";

  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span className={suspended ? "text-ink-soft" : undefined}>{member.name}</span>
          {isMe ? <span className="text-sm font-normal text-ink-soft">(החשבון שלך)</span> : null}
          <Badge tone={member.role === "owner" ? "accent" : "neutral"}>{ROLE_LABELS[member.role]}</Badge>
          {suspended ? <Badge tone="warning">מושבת</Badge> : null}
          {!suspended && !member.isAvailable ? <Badge>לא זמין ללידים</Badge> : null}
          {hasMfa ? <Badge>אימות דו-שלבי</Badge> : null}
        </p>
        {member.email ? (
          <p dir="ltr" className="truncate text-end text-sm text-ink-soft sm:text-start">
            {member.email}
          </p>
        ) : null}
      </div>
      {manageable ? (
        <div className="flex flex-wrap items-start gap-2">
          {suspended ? null : <RoleForm orgId={orgId} member={member} roles={roles} />}
          {suspended || member.role === "viewer" ? null : (
            <ActionButton
              action={setAvailabilityAction.bind(null, orgId, member.userId, !member.isAvailable)}
              pendingText="מעדכן…"
              variant="ghost"
              srLabel={member.name}
            >
              {member.isAvailable ? "סימון כלא זמין" : "סימון כזמין"}
            </ActionButton>
          )}
          {hasMfa && !suspended ? (
            <ActionButton
              action={resetMemberMfaAction.bind(null, orgId, member.userId)}
              pendingText="מאפס…"
              variant="ghost"
              srLabel={member.name}
              confirm={`לאפס את האימות הדו-שלבי של ${member.name}? עשו זאת רק אחרי שווידאתם בשיחה או פנים אל פנים שהבקשה באמת ממנו. המשתמש ינותק מכל המכשירים ויגדיר אימות מחדש בכניסה הבאה.`}
            >
              איפוס אימות דו-שלבי
            </ActionButton>
          ) : null}
          <Link
            href={paths.transferRecords(orgId, member.userId)}
            className="inline-flex min-h-9 items-center px-2 text-sm text-accent-strong underline underline-offset-4"
          >
            העברת רשומות<span className="sr-only">: {member.name}</span>
          </Link>
          <StatusButton orgId={orgId} member={member} />
        </div>
      ) : null}
    </li>
  );
}

function RoleForm({ orgId, member, roles }: { orgId: string; member: Member; roles: InvitableRole[] }) {
  const [selected, setSelected] = useState<string>(member.role);
  const [state, dispatch, pending] = useActionState<FormState, FormData>(
    changeMemberRoleAction.bind(null, orgId, member.userId),
    null,
  );
  const failure = state && !state.ok ? state : null;
  // an admin seen by the owner can be demoted; the current role is always listed
  const options = roles.includes(member.role as InvitableRole) ? roles : [member.role as InvitableRole, ...roles];

  return (
    <form onSubmit={submitWith(dispatch)} className="flex flex-col gap-1" noValidate>
      <div className="flex gap-2">
        <label className="sr-only" htmlFor={`role-${member.userId}`}>
          תפקיד של {member.name}
        </label>
        <Select
          id={`role-${member.userId}`}
          name="role"
          controlSize="sm"
          className="w-36"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {options.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </Select>
        {selected !== member.role ? (
          <SubmitButton size="sm" pending={pending} pendingText="שומר…">
            שמירה
          </SubmitButton>
        ) : null}
      </div>
      <FormError message={failure?.message} className="max-w-72" />
    </form>
  );
}

function StatusButton({ orgId, member }: { orgId: string; member: Member }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const suspended = member.status === "suspended";

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await setMemberStatusAction(orgId, member.userId, suspended ? "active" : "suspended");
      if (!result.ok) {
        setError(result.message);
      }
      setConfirming(false);
    });
  }

  if (suspended) {
    return (
      <div className="flex flex-col gap-1">
        <Button variant="secondary" size="sm" onClick={run} disabled={pending} aria-busy={pending || undefined}>
          {pending ? "מחזיר…" : "החזרה לפעילות"}
          <span className="sr-only">: {member.name}</span>
        </Button>
        <FormError message={error} className="max-w-72" />
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className="flex flex-col gap-1">
        <Button variant="danger-ghost" size="sm" onClick={() => setConfirming(true)}>
          השבתה
          <span className="sr-only">: {member.name}</span>
        </Button>
        <FormError message={error} className="max-w-72" />
      </div>
    );
  }

  return (
    <div role="group" aria-label={`השבתת ${member.name}`} className="w-full rounded-lg border border-line p-3 sm:w-72">
      <p className="text-sm">
        {member.name} ייחסם מייד ולא יוכל להיכנס לעסק. הרשומות וההיסטוריה שלו נשמרות, ואפשר להחזיר אותו בכל עת.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="danger" size="sm" onClick={run} disabled={pending} aria-busy={pending || undefined}>
          {pending ? "משבית…" : "השבתת המשתמש"}
        </Button>
        <Button variant="secondary" size="sm" autoFocus onClick={() => setConfirming(false)} disabled={pending}>
          לא עכשיו
        </Button>
      </div>
    </div>
  );
}
