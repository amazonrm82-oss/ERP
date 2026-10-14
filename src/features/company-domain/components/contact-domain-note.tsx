"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";

import { setContactDomainAction } from "../actions";

type Props = { orgId: string; companyId: string; domain: string; off: boolean; canEdit: boolean };

/**
 * CON-09 on the company card: the email domain the company gets from its contacts, used to link new
 * contacts to it, with one click to switch it off for this company (or back on).
 */
export function ContactDomainNote({ orgId, companyId, domain, off, canEdit }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    setError(null);
    startTransition(async () => {
      const result = await setContactDomainAction(orgId, companyId, !off);
      if (!result.ok) setError(result.message ?? "הפעולה נכשלה.");
    });
  };

  return (
    <div className="space-y-2 rounded-md border border-line bg-canvas px-3 py-2.5 text-sm text-ink print:hidden">
      <p>
        דומיין האימייל: <span dir="ltr">{domain}</span> (לפי אנשי הקשר)
        {off ? ". כבוי: אנשי קשר חדשים לא ישויכו לחברה לפיו." : ". אנשי קשר חדשים עם הדומיין הזה ישויכו לחברה."}
      </p>
      {canEdit ? (
        <Button variant="secondary" size="sm" loading={pending} onClick={toggle}>
          {off ? "הפעלה מחדש" : "כיבוי הדומיין"}
        </Button>
      ) : null}
      <FormError message={error} />
    </div>
  );
}
