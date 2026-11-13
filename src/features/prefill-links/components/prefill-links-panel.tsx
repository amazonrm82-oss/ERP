"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label, Select } from "@/components/ui/field";

import { createPrefillLinkAction, revokePrefillLinkAction } from "../actions";
import type { PrefillRecordType } from "../fields";
import { PREFILL_CARD_TEXTS as T, prefillWhatsappHref, type PrefillRecipientTexts } from "../texts";

export type PanelPrefillLink = { id: string; formName: string; meta: string; state: string; canRevoke: boolean };

type Props = {
  orgId: string;
  record: { kind: PrefillRecordType; id: string };
  canSend: boolean;
  notInPlan: boolean;
  forms: Array<{ id: string; name: string }>;
  links: PanelPrefillLink[];
  settingsHref: string;
  businessName: string;
  recipient: { name: string | null; phoneE164: string | null };
  // who gets the link, in the business's words (prefillRecipientTexts, read on the server; RVW-94)
  texts: PrefillRecipientTexts;
};

/**
 * BIZ-05: make a personal link to a prefill form. The link is shown once, right after it is made (only its hash is kept):
 * copy it or send it then. The list shows every link of the record and its state.
 */
export function PrefillLinksPanel({ orgId, record, canSend, notInPlan, forms, links, settingsHref, businessName, recipient, texts }: Props) {
  const router = useRouter();
  const selectId = useId();
  const inputId = useId();
  const listId = useId();
  const [formId, setFormId] = useState(forms[0]?.id ?? "");
  const [made, setMade] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function create() {
    if (!formId) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    const result = await createPrefillLinkAction(orgId, record.kind, record.id, formId);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setMade(result.data?.url ?? null);
  }

  async function copy(text: string) {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError(T.copyFailed);
    }
  }

  return (
    <div className="space-y-4">
      {notInPlan ? <p className="text-sm text-ink-soft">{T.notInPlan}</p> : null}
      {canSend ? (
        made ? (
          <div className="space-y-3">
            <Label htmlFor={inputId}>{T.linkLabel}</Label>
            <Input id={inputId} dir="ltr" readOnly value={made} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
            <p className="text-sm text-ink-soft">{T.shownOnce}</p>
            <div className="flex flex-wrap gap-2">
              <a
                className={buttonClasses("secondary", "sm")}
                href={prefillWhatsappHref(made, businessName, recipient.name, recipient.phoneE164)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {T.whatsapp}
                <span className="sr-only"> (נפתח בחלון חדש)</span>
              </a>
              <Button size="sm" variant="secondary" onClick={() => void copy(made)}>
                {copied ? T.copied : T.copy}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMade(null);
                  router.refresh();
                }}
              >
                {T.done}
              </Button>
            </div>
          </div>
        ) : forms.length === 0 ? (
          <p className="text-sm text-ink-soft">
            {T.noForms}{" "}
            <a href={settingsHref} className="font-medium text-accent-strong underline-offset-4 hover:underline">
              {T.toSettings}
            </a>
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">{texts.intro}</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 basis-48">
                <Label htmlFor={selectId}>{T.pick}</Label>
                <Select id={selectId} value={formId} onChange={(event) => setFormId(event.target.value)} className="w-full">
                  {forms.map((form) => (
                    <option key={form.id} value={form.id}>
                      {form.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button size="md" variant="secondary" onClick={() => void create()} loading={busy} disabled={!formId}>
                {T.create}
              </Button>
            </div>
          </div>
        )
      ) : null}
      <FormError message={error} />
      <div className="space-y-2">
        <h3 id={listId} className="text-sm font-semibold">
          {T.sent}
        </h3>
        {links.length === 0 ? (
          <p className="text-sm text-ink-soft">{T.none}</p>
        ) : (
          <ul aria-labelledby={listId} className="divide-y divide-line">
            {links.map((link) => (
              <li key={link.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium break-words">
                    <bdi>{link.formName}</bdi>
                    <span className="ms-2 text-ink-soft">({link.state})</span>
                  </p>
                  <p className="text-sm text-ink-soft">{link.meta}</p>
                </div>
                {link.canRevoke ? (
                  <ConfirmButton
                    size="sm"
                    title={T.revokeTitle}
                    description={texts.revokeText}
                    confirmLabel={T.revoke}
                    action={revokePrefillLinkAction.bind(null, orgId, record.kind, record.id, link.id)}
                    onDone={() => router.refresh()}
                  >
                    {T.revoke}
                  </ConfirmButton>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
