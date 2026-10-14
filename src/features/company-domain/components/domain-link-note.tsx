"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { paths } from "@/lib/paths";

import { pickDomainCompanyAction, removeDomainCompanyAction } from "../actions";
import type { DomainLinkInfo } from "../queries";

type Props = { orgId: string; contactId: string; info: NonNullable<DomainLinkInfo>; canEdit: boolean };

/**
 * CON-09 on the contact card: a company linked by the email domain, with one click to remove it;
 * or, when several companies share the domain and none was linked, a choice between them.
 */
export function DomainLinkNote({ orgId, contactId, info, canEdit }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<{ ok: boolean; message?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.message ?? "הפעולה נכשלה.");
    });
  };

  if (info.kind === "linked") {
    return (
      <div className="space-y-2 rounded-md border border-line bg-canvas px-3 py-2.5 text-sm text-ink">
        <p>
          שויך לחברה{" "}
          <Link href={paths.company(orgId, info.company.id)} className="font-medium text-accent underline underline-offset-4">
            {info.company.name}
          </Link>{" "}
          {info.via === "parent" ? (
            <>
              (לפי הדומיין <span dir="ltr">{info.domain}</span>)
            </>
          ) : info.via === "contacts" ? (
            <>
              לפי דומיין האימייל <span dir="ltr">{info.domain}</span> (לפי אנשי הקשר)
            </>
          ) : (
            <>
              לפי דומיין האימייל (<span dir="ltr">{info.domain}</span>)
            </>
          )}
          .
        </p>
        {canEdit ? (
          <Button variant="secondary" size="sm" loading={pending} onClick={() => run(() => removeDomainCompanyAction(orgId, contactId, info.company.id))}>
            הסרת השיוך
          </Button>
        ) : null}
        <FormError message={error} />
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-line bg-canvas px-3 py-2.5 text-sm text-ink">
      <p>
        <span className="font-medium">דומיין שמתאים לכמה חברות</span> (<span dir="ltr">{info.domain}</span>), ולכן איש הקשר לא שויך
        אוטומטית.
        {canEdit ? " אפשר לבחור חברה:" : null}
      </p>
      {canEdit ? (
        <ul className="flex flex-wrap gap-2" aria-label="חברות עם אותו דומיין">
          {info.companies.map((company) => (
            <li key={company.id} className="min-w-0 max-w-full">
              <Button
                variant="secondary"
                size="sm"
                className="max-w-full"
                disabled={pending}
                onClick={() => run(() => pickDomainCompanyAction(orgId, contactId, company.id))}
              >
                <span className="min-w-0 truncate">שיוך ל{company.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="list-inside list-disc">
          {info.companies.map((company) => (
            <li key={company.id}>{company.name}</li>
          ))}
        </ul>
      )}
      {info.more ? (
        <p className="text-ink-soft">
          יש עוד חברות עם הדומיין הזה.{canEdit ? " אפשר לבחור חברה בטופס העריכה." : null}
        </p>
      ) : null}
      <FormError message={error} />
    </div>
  );
}
