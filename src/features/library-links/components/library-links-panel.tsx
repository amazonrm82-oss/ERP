"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label, Select } from "@/components/ui/field";

import { createLibraryLinkAction, revokeLibraryLinkAction } from "../actions";
import type { LibraryRecord } from "../record";
import { libraryMailtoHref, libraryWhatsappHref } from "../share";
import { LIBRARY_CARD_TEXTS as T } from "../texts";

export type PanelLink = {
  id: string;
  itemTitle: string;
  // already formatted for the screen
  meta: string;
  views: string;
  revoked: boolean;
  canRevoke: boolean;
};

type Props = {
  orgId: string;
  record: LibraryRecord;
  canWrite: boolean;
  offerable: Array<{ id: string; title: string }>;
  links: PanelLink[];
  libraryHref: string;
  businessName: string;
  recipient: { name: string | null; phoneE164: string | null; email: string | null };
};

/**
 * LIB-02: send a library item by a personal tracked link. The link is shown once, right after it is made (only its hash is
 * kept): copy it or send it then. The list below shows every link sent to the record and when the customer opened it.
 */
export function LibraryLinksPanel({ orgId, record, canWrite, offerable, links, libraryHref, businessName, recipient }: Props) {
  const router = useRouter();
  const selectId = useId();
  const inputId = useId();
  const listId = useId();
  const [itemId, setItemId] = useState(offerable[0]?.id ?? "");
  const [made, setMade] = useState<{ url: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function create() {
    const item = offerable.find((i) => i.id === itemId);
    if (!item) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    const result = await createLibraryLinkAction(orgId, record, item.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setMade(result.data ? { url: result.data.url, title: item.title } : null);
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
      {canWrite ? (
        made ? (
          <div className="space-y-3">
            <Label htmlFor={inputId}>
              {T.linkLabel}: <bdi>{made.title}</bdi>
            </Label>
            <Input id={inputId} dir="ltr" readOnly value={made.url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
            <p className="text-sm text-ink-soft">{T.shownOnce}</p>
            <div className="flex flex-wrap gap-2">
              <a
                className={buttonClasses("secondary", "sm")}
                href={libraryWhatsappHref(made.url, made.title, businessName, recipient.name, recipient.phoneE164)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {T.whatsapp}
                <span className="sr-only"> (נפתח בחלון חדש)</span>
              </a>
              <a className={buttonClasses("secondary", "sm")} href={libraryMailtoHref(made.url, made.title, businessName, recipient.name, recipient.email)}>
                {T.email}
              </a>
              <Button size="sm" variant="secondary" onClick={() => void copy(made.url)}>
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
        ) : offerable.length === 0 ? (
          <p className="text-sm text-ink-soft">
            {T.noItems}{" "}
            <a href={libraryHref} className="font-medium text-accent-strong underline-offset-4 hover:underline">
              {T.toLibrary}
            </a>
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">{T.intro}</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 basis-48">
                <Label htmlFor={selectId}>{T.pick}</Label>
                <Select id={selectId} value={itemId} onChange={(event) => setItemId(event.target.value)} className="w-full">
                  {offerable.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </Select>
              </div>
              <Button size="md" variant="secondary" onClick={() => void create()} loading={busy} disabled={!itemId}>
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
                    <bdi>{link.itemTitle}</bdi>
                    {link.revoked ? <span className="ms-2 text-ink-soft">({T.revoked})</span> : null}
                  </p>
                  <p className="text-sm text-ink-soft">{link.meta}</p>
                  <p className="text-sm">{link.views}</p>
                </div>
                {link.canRevoke ? (
                  <ConfirmButton
                    size="sm"
                    title={T.revokeTitle}
                    description={T.revokeText}
                    confirmLabel={T.revoke}
                    action={revokeLibraryLinkAction.bind(null, orgId, record, link.id)}
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
