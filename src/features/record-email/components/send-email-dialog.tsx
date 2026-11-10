"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField } from "@/components/ui/field";
import { MailIcon } from "@/components/ui/icons";
import { formatBytes } from "@/features/files/types";
import type { MergeValues } from "@/features/message-templates/fields";
import { messageTemplatesPath } from "@/features/message-templates/paths";
import { MESSAGE_TYPE_LABELS } from "@/features/message-templates/templates";
import type { MessageType } from "@/features/messaging/providers/types";

import { sendRecordEmailAction } from "../actions";
import {
  emailPreview,
  fileSelectionProblem,
  queuedEmailStateText,
  RECORD_EMAIL_MAX_FILES,
  type PickableFile,
  type QueuedEmail,
  type RecordEmailKind,
} from "../logic";

type Template = { id: string; name: string; messageType: MessageType; subject: string | null; body: string };

type Props = {
  orgId: string;
  kind: RecordEmailKind;
  recordId: string;
  address: string;
  templates: Template[];
  files: PickableFile[];
  library: PickableFile[];
  queued: (QueuedEmail & { senderName: string | null })[];
  values: MergeValues;
  canManageTemplates: boolean;
  timeZone: string;
};

const linkClass = "font-medium text-accent underline underline-offset-4 hover:text-accent-strong";

/**
 * EML-02: "שליחת אימייל" on a record's card. The person picks an email template (shown filled with the record's values,
 * a marketing one inside the envelope the system adds) and up to 5 files of the record and the content library (with any
 * template, owner (198) ב; the audit log records which went), and the email is queued; it goes
 * from the platform's address with the person's own address as "reply to". Until a provider is set it waits ("ממתין
 * לשליחה"); the card lists the last emails sent from it and their state.
 */
export function SendEmailDialog(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <MailIcon className="size-4" />
        שליחת אימייל
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="שליחת אימייל ללקוח" variant="sheet">
        {open ? <SendEmailForm {...props} onClose={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function SendEmailForm({ orgId, kind, recordId, address, templates, files, library, queued, values, canManageTemplates, timeZone, onClose }: Props & { onClose: () => void }) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [pickedLibrary, setPickedLibrary] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const template = templates.find((t) => t.id === templateId) ?? null;
  const preview = template ? emailPreview(template, values) : null;
  // owner (198) ב: library files go with a marketing template and with a card's service template alike (a manual send
  // from the card only); a service email stays a service email, without the marketing envelope
  const libraryOffered = template !== null && library.length > 0;
  const sentLibrary = libraryOffered ? pickedLibrary : [];
  const fileProblem = fileSelectionProblem(files, picked, library, sentLibrary);

  function toggle(set: typeof setPicked, id: string, on: boolean) {
    set((current) => (on ? [...new Set([...current, id])] : current.filter((x) => x !== id)));
  }

  function send() {
    if (!template || fileProblem) return;
    setFailure(null);
    startTransition(async () => {
      const result = await sendRecordEmailAction(orgId, kind, recordId, template.id, picked, sentLibrary);
      if (result.ok) setDone(result.message ?? "האימייל ממתין לשליחה.");
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
        נשלח אל <span dir="ltr" className="font-medium text-ink">{address}</span> מהכתובת של המערכת. כשהלקוח עונה, התשובה מגיעה לאימייל שלכם.
      </p>
      {templates.length === 0 ? (
        <p className="text-md text-ink-soft">
          אין תבנית אימייל שאפשר לשלוח מכאן.{" "}
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
              {preview.subject !== null ? (
                <p className="text-md text-ink">
                  <span className="font-medium">נושא: </span>
                  <span className="break-words">{preview.subject}</span>
                </p>
              ) : null}
              <p className="break-words whitespace-pre-wrap text-md text-ink">{preview.body}</p>
            </div>
          ) : null}
          {preview && preview.unfilled.length > 0 ? (
            <p className="text-sm text-ink-soft">{`שדות שהמערכת תמלא בזמן השליחה: ${preview.unfilled.join(", ")}`}</p>
          ) : null}
          {preview?.marketing ? (
            <p className="text-sm text-ink-soft">
              זו הודעה שיווקית: היא תישלח רק אם הלקוח הסכים לקבל הודעות באימייל, והמערכת מוסיפה לה את המילה ״פרסומת״, את פרטי העסק ואת שורת ההסרה.
            </p>
          ) : null}
        </>
      )}

      <fieldset className="space-y-2">
        <legend className="font-medium">{`קבצים לצירוף (עד ${RECORD_EMAIL_MAX_FILES}, עד 10MB יחד)`}</legend>
        <h3 className="text-sm font-medium text-ink-soft">מהרשומה</h3>
        {files.length === 0 ? (
          <p className="text-sm text-ink-soft">אין ברשומה קבצים לצרף.</p>
        ) : (
          <ul className="max-h-48 space-y-2 overflow-y-auto">
            {files.map((file) => (
              <li key={file.id}>
                <Checkbox
                  label={file.name}
                  hint={formatBytes(file.sizeBytes)}
                  checked={picked.includes(file.id)}
                  onChange={(event) => toggle(setPicked, file.id, event.target.checked)}
                />
              </li>
            ))}
          </ul>
        )}
        {libraryOffered ? (
          <>
            <h3 className="text-sm font-medium text-ink-soft">מספריית התוכן</h3>
            {preview && !preview.marketing ? (
              <p className="text-sm text-ink-soft">הקבצים יישלחו כחלק מהודעת השירות, בלי תוספות של הודעה שיווקית.</p>
            ) : null}
            <ul className="max-h-48 space-y-2 overflow-y-auto">
              {library.map((item) => (
                <li key={item.id}>
                  <Checkbox
                    label={item.name}
                    hint={formatBytes(item.sizeBytes)}
                    checked={pickedLibrary.includes(item.id)}
                    onChange={(event) => toggle(setPickedLibrary, item.id, event.target.checked)}
                  />
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <FormError message={fileProblem} />
      </fieldset>

      <FormError message={failure} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={send} loading={pending} disabled={!template || fileProblem !== null}>
          שליחה
        </Button>
        <Button variant="secondary" onClick={onClose}>
          ביטול
        </Button>
      </div>

      {queued.length > 0 ? (
        <section aria-labelledby={`sent-emails-${recordId}`} className="space-y-2 border-t border-line pt-3">
          <h3 id={`sent-emails-${recordId}`} className="font-semibold">
            אימיילים שנשלחו מכאן
          </h3>
          <ul className="space-y-1 text-sm">
            {queued.map((email) => (
              <li key={email.jobId} className="flex flex-wrap gap-x-2">
                <span className="text-ink">{email.templateName ?? "תבנית שנמחקה"}</span>
                <span className="text-ink-soft">
                  {new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(email.createdAt))}
                </span>
                {email.senderName ? <span className="text-ink-soft">{email.senderName}</span> : null}
                {email.files > 0 ? <span className="text-ink-soft">{`${email.files} קבצים`}</span> : null}
                <span className="font-medium text-ink">{queuedEmailStateText(email)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
