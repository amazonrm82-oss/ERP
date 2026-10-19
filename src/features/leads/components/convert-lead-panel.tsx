"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { byGender, DEFAULT_TERMS, withPrefixThe, type OrgTerms } from "@/features/terminology/terms";
import { paths } from "@/lib/paths";
import { submitWith } from "@/lib/use-submit";

import { convertLeadAction } from "../actions";

// FLD-10: the business's words for leads, contacts and deals
type Props = { orgId: string; leadId: string; defaultDealName: string; hasCompany: boolean; terms?: OrgTerms };
type ConvertState = FormState<{ contactId: string; dealId: string | null }>;

const linkClass = "font-medium text-accent underline underline-offset-4 hover:text-accent-strong";

/** "Convert to contact and deal": a button that opens a short form, then links to what was created. */
export function ConvertLeadPanel({ orgId, leadId, defaultDealName, hasCompany, terms = DEFAULT_TERMS }: Props) {
  const { lead, contact, deal } = terms;
  const [open, setOpen] = useState(false);
  const [createDeal, setCreateDeal] = useState(true);
  const [state, dispatch, pending] = useActionState<ConvertState, FormData>(
    convertLeadAction.bind(null, orgId, leadId),
    null,
  );
  const failure = state && !state.ok ? state : null;

  if (state?.ok && state.data) {
    return (
      <div className="space-y-2">
        <FormNotice message={`${lead.theSingular} ${byGender(lead, "הומר", "הומרה")}.`} />
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-md">
          <Link href={paths.contact(orgId, state.data.contactId)} className={linkClass}>
            {withPrefixThe("ל", contact)} {byGender(contact, "שנוצר", "שנוצרה")}
          </Link>
          {state.data.dealId ? (
            <Link href={paths.deal(orgId, state.data.dealId)} className={linkClass}>
              {withPrefixThe("ל", deal)} {byGender(deal, "שנוצר", "שנוצרה")}
            </Link>
          ) : null}
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <div>
        <p className="mb-3 text-md text-ink-soft">
          {lead.theSingular} {byGender(lead, "מתאים", "מתאימה")}? המרה יוצרת {byGender(lead, "ממנו", "ממנה")} {contact.singular}
          {hasCompany ? ", חברה" : ""} ו{deal.singular}, וציר הזמן עובר איתם.
        </p>
        <Button onClick={() => setOpen(true)} className="w-full">
          המר ל{contact.singular} ו{deal.singular}
        </Button>
      </div>
    );
  }

  return (
    // submitted by hand: the checkbox is controlled (see submitWith)
    <form onSubmit={submitWith(dispatch)} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <label className="flex min-h-11 items-center gap-2.5 text-md">
        <input
          type="checkbox"
          name="create_deal"
          checked={createDeal}
          onChange={(event) => setCreateDeal(event.target.checked)}
          className="size-4.5 accent-accent"
        />
        ליצור גם {deal.singular}
      </label>
      {createDeal ? (
        <>
          <TextField
            label={`שם ${deal.theSingular}`}
            name="deal_name"
            maxLength={200}
            autoComplete="off"
            defaultValue={failure?.values?.deal_name ?? defaultDealName}
            error={failure?.fieldErrors?.deal_name}
          />
          <TextField
            label={`שווי ${deal.theSingular} (₪)`}
            name="amount"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            defaultValue={failure?.values?.amount}
            error={failure?.fieldErrors?.amount}
          />
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <SubmitButton size="sm" pending={pending} pendingText="ממירים…">
          המרה
        </SubmitButton>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
