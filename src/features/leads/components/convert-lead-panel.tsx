"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";
import { submitWith } from "@/lib/use-submit";

import { convertLeadAction } from "../actions";

type Props = { orgId: string; leadId: string; defaultDealName: string; hasCompany: boolean };
type ConvertState = FormState<{ contactId: string; dealId: string | null }>;

const linkClass = "font-medium text-accent underline underline-offset-4 hover:text-accent-strong";

/** "Convert to contact and deal": a button that opens a short form, then links to what was created. */
export function ConvertLeadPanel({ orgId, leadId, defaultDealName, hasCompany }: Props) {
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
        <FormNotice message="הליד הומר." />
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-md">
          <Link href={paths.contact(orgId, state.data.contactId)} className={linkClass}>
            לאיש הקשר שנוצר
          </Link>
          {state.data.dealId ? (
            <Link href={paths.deals(orgId)} className={linkClass}>
              לעסקה בלוח העסקאות
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
          הליד מתאים? המרה יוצרת ממנו איש קשר{hasCompany ? ", חברה" : ""} ועסקה, וציר הזמן עובר איתם.
        </p>
        <Button onClick={() => setOpen(true)} className="w-full">
          המר לאיש קשר ועסקה
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
        ליצור גם עסקה
      </label>
      {createDeal ? (
        <>
          <TextField
            label="שם העסקה"
            name="deal_name"
            maxLength={200}
            autoComplete="off"
            defaultValue={failure?.values?.deal_name ?? defaultDealName}
            error={failure?.fieldErrors?.deal_name}
          />
          <TextField
            label="שווי העסקה (₪)"
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
