"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";

import { DEFAULT_TERMS, withPrefixThe, type OrgTerms } from "@/features/terminology/terms";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { initialChoice, pickerLabelName } from "@/components/ui/search-picker-logic";
import { ContactPicker } from "@/features/contacts/components/contact-picker";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { addDealContactAction, removeDealContactAction, setDealContactRoleAction } from "../actions";
import type { DealContactItem } from "../queries";
import { roleChoices, type DealContactRoleOption } from "../roles";

type Props = {
  orgId: string;
  dealId: string;
  canEdit: boolean;
  items: DealContactItem[];
  // the business's list of roles, hidden ones included (CON-03 follow-up)
  roles: DealContactRoleOption[];
  // contacts the add search leaves out: the main contact and the linked ones
  exclude: string[];
  // FLD-10: the business's words
  terms?: OrgTerms;
};

const HIDDEN_NAME = "איש קשר שאין לכם גישה אליו";

function RoleOptions({ roles, currentId }: { roles: DealContactRoleOption[]; currentId: string | null }) {
  const current = roles.find((role) => role.id === currentId) ?? null;
  return (
    <>
      <option value="">ללא תפקיד</option>
      {roleChoices(roles, current).map((role) => (
        <option key={role.id} value={role.id}>
          {role.isActive ? role.name : `${role.name} (מוסתר)`}
        </option>
      ))}
    </>
  );
}

/** One linked contact: its name, its role (a menu for whoever may edit the deal) and "הסרה". */
function DealContactRow({ orgId, dealId, canEdit, item, roles }: { orgId: string; dealId: string; canEdit: boolean; item: DealContactItem; roles: DealContactRoleOption[] }) {
  const current = item.roleId ?? "";
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
            <RoleOptions roles={roles} currentId={item.roleId} />
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
 * CON-03: the contacts on a deal, each with a role in the purchase from the business's list (by default מקבל
 * החלטה, משפיע, משתמש, איש כספים). Whoever may edit the deal adds, changes and removes them.
 */
export function DealContactsCard({ orgId, dealId, canEdit, items, roles, exclude, terms = DEFAULT_TERMS }: Props) {
  const [state, dispatch, pending] = useActionState<FormState, FormData>(addDealContactAction.bind(null, orgId, dealId), null);
  const failure = state && !state.ok ? state : null;

  return (
    <Card aria-labelledby="deal-contacts-title">
      <CardHeader id="deal-contacts-title" title={`${terms.contact.plural} ${withPrefixThe("ב", terms.deal)}`} />
      <CardBody className="space-y-4">
        {items.length === 0 ? (
          <p className="text-md text-ink-soft">
            עוד לא נוספו {terms.contact.plural} {withPrefixThe("ל", terms.deal)}.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <DealContactRow key={`${item.contactId}:${item.roleId ?? ""}`} orgId={orgId} dealId={dealId} canEdit={canEdit} item={item} roles={roles} />
            ))}
          </ul>
        )}

        {canEdit ? (
          // a new key after a failed submit puts back what was chosen (React resets the form)
          <form key={failure ? JSON.stringify(failure.values ?? {}) : `add:${items.length}`} action={dispatch} className="space-y-3 border-t border-line pt-4">
            <ContactPicker
              orgId={orgId}
              label={terms.contact.singular}
              name="contact_id"
              required
              exclude={exclude}
              initial={initialChoice(failure?.values?.contact_id, failure?.values?.[pickerLabelName("contact_id")], terms.contact.singular)}
              error={failure?.fieldErrors?.contact_id}
            />
            <SelectField label="תפקיד" name="role_id" defaultValue={failure?.values?.role_id ?? ""}>
              <RoleOptions roles={roles} currentId={null} />
            </SelectField>
            <SubmitButton size="sm" pending={pending} pendingText="מוסיפים…">
              הוספה {withPrefixThe("ל", terms.deal)}
            </SubmitButton>
            <FormError message={failure && !failure.fieldErrors?.contact_id ? failure.message : null} />
          </form>
        ) : null}
      </CardBody>
    </Card>
  );
}
