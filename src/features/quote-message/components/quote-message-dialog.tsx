"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import type { MergeValues } from "@/features/message-templates/fields";
import { messageTemplatesPath } from "@/features/message-templates/paths";

import { sendQuoteMessageAction } from "../actions";
import { CHANNEL_LABELS, LINK_REPLACED_NOTE, quoteMessagePreview, queuedQuoteMessageText, type QueuedQuoteMessage } from "../logic";
import type { QuoteMessageOption } from "../queries";

type Props = {
  orgId: string;
  quoteId: string;
  options: QuoteMessageOption[];
  queued: (QueuedQuoteMessage & { senderName: string | null })[];
  values: MergeValues;
  // the quote already has a live customer link (the message replaces it)
  linkActive: boolean;
  canManageTemplates: boolean;
  timeZone: string;
};

const linkClass = "font-medium text-accent underline underline-offset-4 hover:text-accent-strong";

/**
 * QUO-18: "שליחה ללקוח" on a sent quote. The person picks the channel (only those the customer has an address for) and a
 * template of type "מסמך שהלקוח ביקש"; the message goes to the customer on the quote with a new link to the quote. Until a
 * provider is connected it waits ("ממתינה לשליחה"); the quote lists its messages and their state.
 */
export function QuoteMessageDialog(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        שליחה ללקוח
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="שליחת ההצעה ללקוח" variant="sheet">
        {open ? <QuoteMessageForm {...props} onClose={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function QuoteMessageForm({ orgId, quoteId, options, queued, values, linkActive, canManageTemplates, timeZone, onClose }: Props & { onClose: () => void }) {
  const [channel, setChannel] = useState(options[0]?.channel ?? "email");
  const option = options.find((o) => o.channel === channel) ?? null;
  const [templateId, setTemplateId] = useState(option?.templates[0]?.id ?? "");
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const template = option?.templates.find((t) => t.id === templateId) ?? null;
  const preview = template ? quoteMessagePreview(template, values) : null;

  function pickChannel(next: string) {
    const nextOption = options.find((o) => o.channel === next);
    if (!nextOption) return;
    setChannel(nextOption.channel);
    setTemplateId(nextOption.templates[0]?.id ?? "");
  }

  function send() {
    if (!template || !option) return;
    setFailure(null);
    startTransition(async () => {
      const result = await sendQuoteMessageAction(orgId, quoteId, option.channel, template.id);
      if (result.ok) setDone(result.message ?? "ההודעה נכנסה לתור השליחה.");
      else setFailure(result.message);
    });
  }

  if (done) {
    return (
      <div className="space-y-4">
        <p className="text-md" role="status">
          {done}
        </p>
        <Button variant="secondary" onClick={onClose} autoFocus>
          סגירה
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {options.length === 0 ? (
        <p className="text-md text-ink-soft">לאיש הקשר של ההצעה אין אימייל או מספר טלפון שאפשר לשלוח אליו. הוסיפו אותם בכרטיס איש הקשר.</p>
      ) : (
        <>
          {options.length > 1 ? (
            <SelectField label="ערוץ" value={channel} onChange={(event) => pickChannel(event.target.value)}>
              {options.map((o) => (
                <option key={o.channel} value={o.channel}>
                  {CHANNEL_LABELS[o.channel]}
                </option>
              ))}
            </SelectField>
          ) : null}
          {option ? (
            <p className="text-sm text-ink-soft">
              {`נשלח ב${CHANNEL_LABELS[option.channel]} אל `}
              <span dir="ltr" className="font-medium text-ink">
                {option.address}
              </span>
            </p>
          ) : null}
          {option && option.templates.length === 0 ? (
            <p className="text-md text-ink-soft">
              אין תבנית מסוג &quot;מסמך שהלקוח ביקש&quot; לערוץ הזה שאפשר לשלוח מההצעה.{" "}
              {canManageTemplates ? (
                <Link href={messageTemplatesPath(orgId)} className={linkClass}>
                  לתבניות ההודעה
                </Link>
              ) : (
                "בעלים ומנהלי מערכת יכולים להוסיף תבנית."
              )}
            </p>
          ) : null}
          {option && option.templates.length > 0 ? (
            <SelectField label="תבנית" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              {option.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectField>
          ) : null}
          {preview ? (
            <div className="space-y-2 rounded-md border border-line bg-canvas px-3 py-3" aria-label="תצוגה מקדימה">
              {preview.subject ? <p className="font-semibold text-ink">{preview.subject}</p> : null}
              <p className="break-words whitespace-pre-wrap text-md text-ink">{preview.body}</p>
            </div>
          ) : null}
          {preview && preview.unfilled.length > 0 ? (
            <p className="text-sm text-ink-soft">{`שדות שהמערכת תמלא בזמן השליחה: ${preview.unfilled.join(", ")}`}</p>
          ) : null}
          {linkActive ? <p className="text-sm text-ink-soft">{LINK_REPLACED_NOTE}</p> : null}
        </>
      )}

      <FormError message={failure} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={send} loading={pending} disabled={!template}>
          שליחה
        </Button>
        <Button variant="secondary" onClick={onClose}>
          ביטול
        </Button>
      </div>

      {queued.length > 0 ? (
        <section aria-labelledby={`quote-messages-${quoteId}`} className="space-y-2 border-t border-line pt-3">
          <h3 id={`quote-messages-${quoteId}`} className="font-semibold">
            הודעות שנשלחו עם ההצעה
          </h3>
          <ul className="space-y-1 text-sm">
            {queued.map((m) => (
              <li key={m.jobId} className="flex flex-wrap gap-x-2">
                <span className="text-ink">{CHANNEL_LABELS[m.channel]}</span>
                <span className="text-ink">{m.templateName ?? "תבנית שנמחקה"}</span>
                <span className="text-ink-soft">
                  {new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(m.createdAt))}
                </span>
                {m.senderName ? <span className="text-ink-soft">{m.senderName}</span> : <span className="text-ink-soft">תזכורת אוטומטית</span>}
                <span className="font-medium text-ink">{queuedQuoteMessageText(m)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
