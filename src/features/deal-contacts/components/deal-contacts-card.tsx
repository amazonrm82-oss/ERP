"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { addDealContactAction, removeDealContactAction, setDealContactRoleAction } from "../actions";
import type { DealContactItem } from "../queries";
import { DEAL_CONTACT_ROLES } from "../roles";

type ContactOption = { id: string; name: string };

type Props = {
  orgId: string;
  dealId: string;
  canEdit: boolean;
  items: DealContactItem[];
  // contacts the user may pick (already without the linked ones)
  options: ContactOption[];
};

const HIDDEN_NAME = "איש קשר שאין לכם גישה אליו";

function RoleOptions() {
  return (
    <>
      <option value="">ללא תפקיד</option>
      {DEAL_CONTACT_ROLES.map((role) => (
        <option key={role.key} value={role.key}>
          {role.label}
        </option>
      ))}
    </>
  );
}

/** One linked contact: its name, its role (a menu for whoever may edit the deal) and "הסרה". */
function DealContactRow({ orgId, dealId, canEdit, item }: { orgId: string; dealId: string; canEdit: boolean; item: DealContactItem }) {
  const current = item.role ?? "";
  const [selected, setSelected] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const name = item.name ?? HIDDEN_NAME;
  const changed = selected !== current;

  function saveRole() {
    setError(null);
    startTransition(async () => {
      const result = await setDealContactRoleAction(orgId, dealId, item.contactId, selected);
      if (!result.ok) setError(result.message);
    });
  }

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          {item.name && !item.inTrash ? (
            <Link href={paths.contact(orgId, item.contactId)} className="block break-words font-medium underline-offset-4 hover:underline">
              {name}
            </Link>
          ) : (
            <span className="block break-words font-medium">{name}</span>
          )}
          {item.inTrash ? <span className="block text-sm text-ink-soft">בסל המחזור</span> : null}
          {!canEdit ? <span className="block text-sm text-ink-soft">{item.roleLabel ?? "ללא תפקיד"}</span> : null}
        </span>
        {canEdit ? (
          <ConfirmButton
            title={`להסיר את ${name} מהעסקה?`}
            description="איש הקשר עצמו נשאר במערכת."
            confirmLabel="הסרה"
            action={() => removeDealContactAction(orgId, dealId, item.contactId)}
          >
            הסרה
          </ConfirmButton>
        ) : null}
      </div>
      {canEdit ? (
        <div className="flex items-end gap-2">
          <SelectField
            label={`התפקיד של ${name} בעסקה`}
            hideLabel
            controlSize="sm"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            className="min-w-0 flex-1"
          >
            <RoleOptions />
          </SelectField>
          {changed ? (
            <Button size="sm" onClick={saveRole} loading={pending}>
              שמירה
            </Button>
          ) : null}
        </div>
      ) : null}
      <FormError message={error} />
    </li>
  );
}

/**
 * CON-03: the contacts on a deal, each with a role in the purchase (מקבל החלטה, משפיע,
 * משתמש, איש כספים). Whoever may edit the deal adds, changes and removes them.
 */
export function DealContactsCard({ orgId, dealId, canEdit, items, options }: Props) {
  const [state, dispatch, pending] = useActionState<FormState, FormData>(addDealContactAction.bind(null, orgId, dealId), null);
  const failure = state && !state.ok ? state : null;

  return (
    <Card aria-labelledby="deal-contacts-title">
      <CardHeader id="deal-contacts-title" title="אנשי קשר בעסקה" />
      <CardBody className="space-y-4">
        {items.length === 0 ? (
          <p className="text-md text-ink-soft">עוד לא נוספו אנשי קשר לעסקה.</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <DealContactRow key={`${item.contactId}:${item.role ?? ""}`} orgId={orgId} dealId={dealId} canEdit={canEdit} item={item} />
            ))}
          </ul>
        )}

        {canEdit ? (
          options.length === 0 ? (
            <p className="text-sm text-ink-soft">אין עוד אנשי קשר להוספה.</p>
          ) : (
            // a new key after a failed submit puts back what was chosen (React resets the form)
            <form key={failure ? JSON.stringify(failure.values ?? {}) : "add"} action={dispatch} className="space-y-3 border-t border-line pt-4">
              <SelectField
                label="איש קשר"
                name="contact_id"
                required
                defaultValue={failure?.values?.contact_id ?? ""}
                error={failure?.fieldErrors?.contact_id}
              >
                <option value="" disabled>
                  בחירת איש קשר
                </option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </SelectField>
              <SelectField label="תפקיד" name="role" defaultValue={failure?.values?.role ?? ""}>
                <RoleOptions />
              </SelectField>
              <SubmitButton size="sm" pending={pending} pendingText="מוסיפים…">
                הוספה לעסקה
              </SubmitButton>
              <FormError message={failure && !failure.fieldErrors?.contact_id ? failure.message : null} />
            </form>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}
