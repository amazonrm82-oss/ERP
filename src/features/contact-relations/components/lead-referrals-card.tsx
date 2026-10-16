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

import { addLeadReferralAction, removeLeadReferralAction } from "../actions";
import type { ContactRelationItem } from "../queries";

type Props = {
  orgId: string;
  leadId: string;
  // edit the lead, and it is not converted (its referrals then live on its contact)
  canEdit: boolean;
  items: ContactRelationItem[];
  // the business's referral type, while it is active ("הפנה/תה את")
  phrase: string | null;
  // live contacts the user may pick
  people: Array<{ id: string; name: string }>;
};

/** CON-06: the contacts this lead referred. On conversion they move to the lead's new contact. */
export function LeadReferralsCard({ orgId, leadId, canEdit, items, phrase, people }: Props) {
  const [state, dispatch, pending] = useActionState<FormState, FormData>(addLeadReferralAction.bind(null, orgId, leadId), null);
  const failure = state && !state.ok ? state : null;

  return (
    <Card aria-labelledby="lead-referrals-title">
      <CardHeader id="lead-referrals-title" title={`הפניות (${items.length})`} />
      <CardBody className="space-y-4">
        {items.length === 0 ? (
          <p className="text-md text-ink-soft">הליד עוד לא הפנה אנשי קשר.</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <span className="block text-sm text-ink-soft">{item.phrase}</span>
                  {item.otherInTrash ? (
                    <span className="block break-words font-medium">{item.otherName}</span>
                  ) : (
                    <Link href={paths.contact(orgId, item.otherId)} className="block break-words font-medium underline-offset-4 hover:underline">
                      {item.otherName}
                    </Link>
                  )}
                  {item.otherInTrash ? <span className="block text-sm text-ink-soft">בסל המחזור</span> : null}
                </span>
                {canEdit ? (
                  <ConfirmButton
                    title={`להסיר את ההפניה של ${item.otherName}?`}
                    description="הליד ואיש הקשר נשארים במערכת."
                    confirmLabel="הסרה"
                    action={() => removeLeadReferralAction(orgId, leadId, item.id)}
                  >
                    הסרה
                  </ConfirmButton>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          phrase === null || people.length === 0 ? (
            <p className="text-sm text-ink-soft">{phrase === null ? "סוג הקשר של הפניות לא פעיל ברשימה של העסק." : "אין אנשי קשר לבחור."}</p>
          ) : (
            // a new key after a failed submit puts back what was chosen (React resets the form)
            <form key={failure ? JSON.stringify(failure.values ?? {}) : `add:${items.length}`} action={dispatch} className="space-y-3 border-t border-line pt-4">
              <SelectField label={`הליד ${phrase}`} name="other_id" required defaultValue={failure?.values?.other_id ?? ""} error={failure?.fieldErrors?.other_id}>
                <option value="" disabled>
                  בחירת איש קשר
                </option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </SelectField>
              <SubmitButton size="sm" pending={pending} pendingText="שומרים…">
                הוספת הפניה
              </SubmitButton>
              <FormError message={failure && !failure.fieldErrors?.other_id ? failure.message : null} />
            </form>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}
