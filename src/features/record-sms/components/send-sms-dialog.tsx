"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { ChatIcon } from "@/components/ui/icons";
import type { MergeValues } from "@/features/message-templates/fields";
import { messageTemplatesPath } from "@/features/message-templates/paths";
import { MESSAGE_TYPE_LABELS } from "@/features/message-templates/templates";
import type { MessageType } from "@/features/messaging/providers/types";

import { sendRecordSmsAction } from "../actions";
import { queuedSmsStateText, SMS_TOO_LONG, smsPreview, type QueuedSms, type RecordSmsKind } from "../logic";

type Template = { id: string; name: string; messageType: MessageType; body: string };

type Props = {
  orgId: string;
  kind: RecordSmsKind;
  recordId: string;
  phone: string;
  templates: Template[];
  queued: (QueuedSms & { senderName: string | null })[];
  values: MergeValues;
  canManageTemplates: boolean;
  timeZone: string;
};

const linkClass = "font-medium text-accent underline underline-offset-4 hover:text-accent-strong";

/**
 * SMS-02: "שליחת SMS" on a record's card. The person picks an SMS template (shown filled with the record's values, a
 * marketing one with the parts the system adds) and the SMS is queued under the business's sender name (SMS-01). Until an SMS
 * provider is connected it waits ("ממתין לשליחה"); the card lists the last SMS sent from it and their state.
 */
export function SendSmsDialog(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <ChatIcon className="size-4" />
        שליחת SMS
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="שליחת SMS ללקוח" variant="sheet">
        {open ? <SendSmsForm {...props} onClose={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function SendSmsForm({ orgId, kind, recordId, phone, templates, queued, values, canManageTemplates, timeZone, onClose }: Props & { onClose: () => void }) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const template = templates.find((t) => t.id === templateId) ?? null;
  const preview = template ? smsPreview(template, values) : null;

  function send() {
    if (!template || preview?.tooLong) return;
    setFailure(null);
    startTransition(async () => {
      const result = await sendRecordSmsAction(orgId, kind, recordId, template.id);
      if (result.ok) setDone(result.message ?? "ה-SMS ממתין לשליחה.");
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
      <p className="text-sm text-ink-soft">
        נשלח אל <span dir="ltr" className="font-medium text-ink">{phone}</span> בשם השולח של העסק.
      </p>
      {templates.length === 0 ? (
        <p className="text-md text-ink-soft">
          אין תבנית SMS שאפשר לשלוח מכאן.{" "}
          {canManageTemplates ? (
            <Link href={messageTemplatesPath(orgId)} className={linkClass}>
              להוספת תבנית
            </Link>
          ) : (
            "בעלים ומנהלי מערכת יכולים להוסיף תבנית."
          )}
        </p>
      ) : (
        <>
          <SelectField label="תבנית" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {`${t.name} (${MESSAGE_TYPE_LABELS[t.messageType]})`}
              </option>
            ))}
          </SelectField>
          {preview ? (
            <div className="space-y-2 rounded-md border border-line bg-canvas px-3 py-3" aria-label="תצוגה מקדימה">
              <p className="break-words whitespace-pre-wrap text-md text-ink">{preview.body}</p>
              <p className="text-sm text-ink-soft">{preview.parts === 1 ? `${preview.characters} תווים, הודעה אחת` : `${preview.characters} תווים, ${preview.parts} הודעות`}</p>
            </div>
          ) : null}
          {preview && preview.unfilled.length > 0 ? (
            <p className="text-sm text-ink-soft">{`שדות שהמערכת תמלא בזמן השליחה: ${preview.unfilled.join(", ")}`}</p>
          ) : null}
          {preview?.marketing ? (
            <p className="text-sm text-ink-soft">
              זו הודעה שיווקית: היא תישלח רק אם הלקוח הסכים לקבל הודעות ב-SMS, והמערכת מוסיפה לה את המילה ״פרסומת״, את פרטי העסק ואת שורת ההסרה.
            </p>
          ) : null}
          <FormError message={preview?.tooLong ? SMS_TOO_LONG : null} />
        </>
      )}

      <FormError message={failure} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={send} loading={pending} disabled={!template || preview?.tooLong === true}>
          שליחה
        </Button>
        <Button variant="secondary" onClick={onClose}>
          ביטול
        </Button>
      </div>

      {queued.length > 0 ? (
        <section aria-labelledby={`sent-sms-${recordId}`} className="space-y-2 border-t border-line pt-3">
          <h3 id={`sent-sms-${recordId}`} className="font-semibold">
            הודעות SMS שנשלחו מכאן
          </h3>
          <ul className="space-y-1 text-sm">
            {queued.map((sms) => (
              <li key={sms.jobId} className="flex flex-wrap gap-x-2">
                <span className="text-ink">{sms.templateName ?? "תבנית שנמחקה"}</span>
                <span className="text-ink-soft">
                  {new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(sms.createdAt))}
                </span>
                {sms.senderName ? <span className="text-ink-soft">{sms.senderName}</span> : null}
                <span className="font-medium text-ink">{queuedSmsStateText(sms)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
