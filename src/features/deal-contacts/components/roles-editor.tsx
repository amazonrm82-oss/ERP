"use client";

import { useActionState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addDealContactRoleAction, deleteDealContactRoleAction, moveDealContactRoleAction, renameDealContactRoleAction, setDealContactRoleActiveAction } from "../actions-roles";
import type { DealContactRoleOption } from "../roles";
import { DEAL_CONTACT_ROLE_NAME_MAX } from "../roles";

/** The business's roles of contacts on a deal (CON-03 follow-up): rename, hide, reorder and delete. */
export function DealContactRoleList({ orgId, roles, editable }: { orgId: string; roles: DealContactRoleOption[]; editable: boolean }) {
  return (
    <ol className="divide-y divide-line">
      {roles.map((role, index) => (
        <RoleRow
          key={`${role.id}-${role.name}-${role.isActive}`}
          orgId={orgId}
          role={role}
          editable={editable}
          isFirst={index === 0}
          isLast={index === roles.length - 1}
        />
      ))}
    </ol>
  );
}

type RowProps = { orgId: string; role: DealContactRoleOption; editable: boolean; isFirst: boolean; isLast: boolean };

function RoleRow({ orgId, role, editable, isFirst, isLast }: RowProps) {
  const [state, formAction] = useActionState<FormState, FormData>(renameDealContactRoleAction.bind(null, orgId, role.id), null);
  const failure = state && !state.ok ? state : null;

  if (!editable) {
    return (
      <li className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <span className="min-w-0 break-words font-medium">{role.name}</span>
        {role.isActive ? null : <Badge>מוסתר</Badge>}
      </li>
    );
  }

  return (
    <li className="space-y-2 px-4 py-3 sm:px-5">
      <form action={formAction} className="flex items-start gap-2" noValidate>
        <TextField
          label={`שם התפקיד ${role.name}`}
          hideLabel
          name="name"
          required
          maxLength={DEAL_CONTACT_ROLE_NAME_MAX}
          autoComplete="off"
          controlSize="sm"
          className="min-w-0 flex-1"
          defaultValue={failure?.values?.name ?? role.name}
          error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
        />
        <SubmitButton size="sm" variant="secondary">
          שמירה
          <span className="sr-only">: {role.name}</span>
        </SubmitButton>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        {role.isActive ? null : <Badge>מוסתר</Badge>}
        <ActionButton action={moveDealContactRoleAction.bind(null, orgId, role.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={role.name} disabled={isFirst}>
          הזזה למעלה
        </ActionButton>
        <ActionButton action={moveDealContactRoleAction.bind(null, orgId, role.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={role.name} disabled={isLast}>
          הזזה למטה
        </ActionButton>
        <ActionButton action={setDealContactRoleActiveAction.bind(null, orgId, role.id, !role.isActive)} pendingText="מעדכנים…" variant="ghost" srLabel={role.name}>
          {role.isActive ? "הסתרה" : "הצגה"}
        </ActionButton>
        <ActionButton
          action={deleteDealContactRoleAction.bind(null, orgId, role.id)}
          pendingText="מוחקים…"
          variant="danger-ghost"
          srLabel={role.name}
          confirm={`למחוק את התפקיד "${role.name}"? אנשי קשר שסומנו בו יישארו בעסקאות, בלי תפקיד.`}
        >
          מחיקה
        </ActionButton>
      </div>
    </li>
  );
}

export function AddDealContactRoleForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addDealContactRoleAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="flex items-start gap-2" noValidate>
      <TextField
        label="תפקיד חדש"
        hideLabel
        placeholder="תפקיד חדש, למשל: יועץ משפטי"
        name="name"
        required
        maxLength={DEAL_CONTACT_ROLE_NAME_MAX}
        autoComplete="off"
        controlSize="sm"
        className="min-w-0 flex-1"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
      />
      <SubmitButton size="sm" pendingText="מוסיפים…">
        הוספת תפקיד
      </SubmitButton>
    </form>
  );
}
