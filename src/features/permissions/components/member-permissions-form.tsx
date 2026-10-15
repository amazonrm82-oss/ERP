"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { setMemberPermissionsAction } from "../actions";
import { MEMBER_PERMISSIONS, type MemberPermission, type MemberPermissionInfo } from "../keys";

type Props = {
  orgId: string;
  userId: string;
  name: string;
  granted: MemberPermission[];
  // false: read only (the business is read-only, or the plan does not hold the capability)
  canEdit: boolean;
};

/** PRM-01: the extra permissions of one manager or member, as checkboxes saved together. */
export function MemberPermissionsForm({ orgId, userId, name, granted, canEdit }: Props) {
  const [state, dispatch] = useActionState<FormState, FormData>(setMemberPermissionsAction.bind(null, orgId, userId), null);
  const shown = MEMBER_PERMISSIONS.filter((permission) => permission.built);
  // keys whose box asks before it is ticked (owner, 15 October 2026: automations), held as state
  const [ticked, setTicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(shown.filter((p) => p.confirm).map((p) => [p.key, granted.includes(p.key)])),
  );
  const [asking, setAsking] = useState<MemberPermissionInfo | null>(null);

  return (
    <form onSubmit={submitWith(dispatch)} className="space-y-4" noValidate>
      <fieldset className="space-y-4" disabled={!canEdit}>
        <legend className="mb-3 text-md font-medium">ההרשאות של {name}, נוסף על התפקיד</legend>
        {shown.map((permission) => (
          <div key={permission.key} className="space-y-1.5">
            {permission.confirm ? (
              <Checkbox
                name="permission"
                value={permission.key}
                checked={ticked[permission.key] ?? false}
                onChange={(event) => {
                  if (event.target.checked) setAsking(permission);
                  else setTicked((t) => ({ ...t, [permission.key]: false }));
                }}
                label={permission.label}
                hint={permission.description}
              />
            ) : (
              <Checkbox
                name="permission"
                value={permission.key}
                defaultChecked={granted.includes(permission.key)}
                label={permission.label}
                hint={permission.description}
              />
            )}
            {permission.warning ? (
              <p role="note" className="ms-8 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                {permission.warning}
              </p>
            ) : null}
          </div>
        ))}
      </fieldset>
      {state && !state.ok ? <FormError message={state.message} /> : null}
      {state?.ok ? <FormNotice message={state.message} /> : null}
      {canEdit ? <SubmitButton pendingText="שומרים…">שמירת ההרשאות</SubmitButton> : null}
      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking ? `לתת ל${name} ${asking.label}?` : ""}
        description={asking?.warning}
        footer={
          <>
            <Button variant="secondary" autoFocus onClick={() => setAsking(null)}>
              לא עכשיו
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (asking) setTicked((t) => ({ ...t, [asking.key]: true }));
                setAsking(null);
              }}
            >
              לתת את ההרשאה
            </Button>
          </>
        }
      />
    </form>
  );
}
