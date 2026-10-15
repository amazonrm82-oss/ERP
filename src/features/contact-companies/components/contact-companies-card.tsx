"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { addContactCompanyAction, makePrimaryCompanyAction, removeContactCompanyAction, setContactCompanyTitleAction } from "../actions";
import type { ContactCompanyItem } from "../queries";
import { TITLE_MAX } from "../schema";

type CompanyOption = { id: string; name: string };

type Props = {
  orgId: string;
  contactId: string;
  canEdit: boolean;
  items: ContactCompanyItem[];
  // live companies the user may pick (the linked ones are left out here)
  options: CompanyOption[];
};

/** One company of the contact: its name, the role there, the primary mark, and the actions for whoever may edit the contact. */
function CompanyRow({
  orgId,
  contactId,
  canEdit,
  item,
  makePrimaryId,
}: {
  orgId: string;
  contactId: string;
  canEdit: boolean;
  item: ContactCompanyItem;
  // the first company that may become primary: "לבחור" moves the focus to its button
  makePrimaryId?: string;
}) {
  const current = item.title ?? "";
  const [title, setTitle] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const changed = title.trim() !== current;

  function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.message ?? null);
    });
  }

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            {item.inTrash ? (
              <span className="break-words font-medium">{item.name}</span>
            ) : (
              <Link href={paths.company(orgId, item.companyId)} className="break-words font-medium underline-offset-4 hover:underline">
                {item.name}
              </Link>
            )}
            {item.isPrimary ? <Badge tone="accent">חברה ראשית</Badge> : null}
          </span>
          {item.inTrash ? <span className="block text-sm text-ink-soft">בסל המחזור</span> : null}
          {!canEdit ? <span className="block text-sm text-ink-soft">{item.title ?? "ללא תפקיד"}</span> : null}
        </span>
        {canEdit ? (
          <ConfirmButton
            title={`להסיר את ${item.name} מאיש הקשר?`}
            description={item.isPrimary ? "זו החברה הראשית: איש הקשר יישאר בלי חברה ראשית. החברה עצמה נשארת במערכת." : "החברה עצמה נשארת במערכת."}
            confirmLabel="הסרה"
            action={() => removeContactCompanyAction(orgId, contactId, item.id)}
          >
            הסרה
          </ConfirmButton>
        ) : null}
      </div>
      {canEdit ? (
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            label={`התפקיד ב${item.name}`}
            hideLabel
            placeholder="תפקיד בחברה"
            maxLength={TITLE_MAX}
            controlSize="sm"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="min-w-0 flex-1 basis-40"
          />
          {changed ? (
            <Button size="sm" onClick={() => run(() => setContactCompanyTitleAction(orgId, contactId, item.id, title))} loading={pending}>
              שמירה
            </Button>
          ) : null}
          {!item.isPrimary && !item.inTrash ? (
            <Button id={makePrimaryId} size="sm" variant="secondary" onClick={() => run(() => makePrimaryCompanyAction(orgId, contactId, item.companyId))} disabled={pending}>
              קביעה כראשית
            </Button>
          ) : null}
        </div>
      ) : null}
      <FormError message={error} />
    </li>
  );
}

/**
 * CON-05: the companies a contact works with, each with the role there; one is the primary company (the one in the
 * contact's details). Whoever may edit the contact adds, changes and removes them.
 */
export function ContactCompaniesCard({ orgId, contactId, canEdit, items, options }: Props) {
  const [state, dispatch, pending] = useActionState<FormState, FormData>(addContactCompanyAction.bind(null, orgId, contactId), null);
  const failure = state && !state.ok ? state : null;
  const linked = new Set(items.map((item) => item.companyId));
  // CON-05 (owner, 15 October 2026): companies but no primary one, e.g. after the primary company was deleted for good
  const noPrimary = items.length > 0 && !items.some((item) => item.isPrimary);
  const firstChoice = canEdit ? items.find((item) => !item.isPrimary && !item.inTrash) : undefined;
  const makePrimaryId = `make-primary-${contactId}`;
  const choices = options.filter((option) => !linked.has(option.id));

  return (
    <Card aria-labelledby="contact-companies-title">
      <CardHeader id="contact-companies-title" title={`חברות (${items.length})`} />
      <CardBody className="space-y-4">
        {noPrimary ? (
          <p className="text-sm text-ink-soft">
            אין חברה ראשית
            {firstChoice ? (
              <>
                {": "}
                <button
                  type="button"
                  className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong"
                  onClick={() => document.getElementById(makePrimaryId)?.focus()}
                >
                  לבחור
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        {items.length === 0 ? (
          <p className="text-md text-ink-soft">איש הקשר עוד לא מקושר לחברה.</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <CompanyRow
                key={`${item.id}:${item.title ?? ""}:${item.isPrimary}`}
                orgId={orgId}
                contactId={contactId}
                canEdit={canEdit}
                item={item}
                makePrimaryId={item.id === firstChoice?.id ? makePrimaryId : undefined}
              />
            ))}
          </ul>
        )}

        {canEdit ? (
          choices.length === 0 ? (
            <p className="text-sm text-ink-soft">אין עוד חברות לקישור.</p>
          ) : (
            // a new key after a failed submit puts back what was chosen (React resets the form)
            <form key={failure ? JSON.stringify(failure.values ?? {}) : `add:${items.length}`} action={dispatch} className="space-y-3 border-t border-line pt-4">
              <SelectField label="חברה" name="company_id" required defaultValue={failure?.values?.company_id ?? ""} error={failure?.fieldErrors?.company_id}>
                <option value="" disabled>
                  בחירת חברה
                </option>
                {choices.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="תפקיד בחברה"
                name="title"
                maxLength={TITLE_MAX}
                defaultValue={failure?.values?.title ?? ""}
                error={failure?.fieldErrors?.title}
              />
              <SubmitButton size="sm" pending={pending} pendingText="מקשרים…">
                קישור לחברה
              </SubmitButton>
              <FormError message={failure && !failure.fieldErrors?.company_id && !failure.fieldErrors?.title ? failure.message : null} />
            </form>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}
