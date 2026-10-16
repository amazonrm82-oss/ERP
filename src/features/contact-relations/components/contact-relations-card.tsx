"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { addContactRelationAction, removeContactRelationAction } from "../actions";
import type { ContactRelationItem } from "../queries";

type Option = { value: string; label: string };

type Props = {
  orgId: string;
  contactId: string;
  canEdit: boolean;
  items: ContactRelationItem[];
  // each active type in this contact's direction ("הורה של", "ילד/ה של" …)
  choices: Option[];
  // other live contacts the user may pick
  people: Array<{ id: string; name: string }>;
};

/**
 * CON-06: the people this contact is related to: spouse, parent and child, who referred whom, and the business's own
 * types. Each line reads from this contact: "<this contact's relation> <the other person>".
 */
export function ContactRelationsCard({ orgId, contactId, canEdit, items, choices, people }: Props) {
  const [state, dispatch, pending] = useActionState<FormState, FormData>(addContactRelationAction.bind(null, orgId, contactId), null);
  const failure = state && !state.ok ? state : null;
  const others = people.filter((person) => person.id !== contactId);

  return (
    <Card aria-labelledby="contact-relations-title">
      <CardHeader id="contact-relations-title" title={`קשרים (${items.length})`} />
      <CardBody className="space-y-4">
        {items.length === 0 ? (
          <p className="text-md text-ink-soft">עוד לא נרשמו קשרים לאנשי קשר אחרים.</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <span className="block text-sm text-ink-soft">{item.phrase}</span>
                  {item.otherInTrash ? (
                    <span className="block break-words font-medium">{item.otherName}</span>
                  ) : (
                    <Link href={item.otherKind === "lead" ? paths.lead(orgId, item.otherId) : paths.contact(orgId, item.otherId)} className="block break-words font-medium underline-offset-4 hover:underline">
                      {item.otherName}
                    </Link>
                  )}
                  {item.otherKind === "lead" ? <span className="block text-sm text-ink-soft">ליד</span> : null}
                  {item.otherInTrash ? <span className="block text-sm text-ink-soft">בסל המחזור</span> : null}
                </span>
                {canEdit ? (
                  <ConfirmButton
                    title={`להסיר את הקשר עם ${item.otherName}?`}
                    description={item.otherKind === "lead" ? "איש הקשר והליד נשארים במערכת." : "שני אנשי הקשר נשארים במערכת."}
                    confirmLabel="הסרה"
                    action={() => removeContactRelationAction(orgId, contactId, item.id)}
                  >
                    הסרה
                  </ConfirmButton>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          choices.length === 0 || others.length === 0 ? (
            <p className="text-sm text-ink-soft">{choices.length === 0 ? "אין סוגי קשר פעילים ברשימה של העסק." : "אין עוד אנשי קשר לקשר אליהם."}</p>
          ) : (
            // a new key after a failed submit puts back what was chosen (React resets the form)
            <form key={failure ? JSON.stringify(failure.values ?? {}) : `add:${items.length}`} action={dispatch} className="space-y-3 border-t border-line pt-4">
              <SelectField label="איש הקשר הזה הוא" name="choice" required defaultValue={failure?.values?.choice ?? ""} error={failure?.fieldErrors?.choice}>
                <option value="" disabled>
                  בחירת סוג קשר
                </option>
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </SelectField>
              <SelectField label="איש קשר" name="other_id" required defaultValue={failure?.values?.other_id ?? ""} error={failure?.fieldErrors?.other_id}>
                <option value="" disabled>
                  בחירת איש קשר
                </option>
                {others.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </SelectField>
              <SubmitButton size="sm" pending={pending} pendingText="שומרים…">
                הוספת קשר
              </SubmitButton>
              <FormError message={failure && !failure.fieldErrors?.choice && !failure.fieldErrors?.other_id ? failure.message : null} />
            </form>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}
