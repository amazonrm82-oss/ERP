"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { NoteText } from "@/features/activities/components/note-text";
import type { DocumentRecordType } from "@/features/document-templates/fields";

import { prepareSignatureDocumentAction, sendSignatureDocumentAction, type DraftSegment } from "../actions";
import type { SendableTemplate } from "../queries";
import { signatureWhatsappHref } from "../states";

type Props = {
  orgId: string;
  kind: DocumentRecordType;
  recordId: string;
  templates: SendableTemplate[];
  businessName: string;
  phoneE164: string | null;
};

type Prepared = { templateId: string; title: string; segments: DraftSegment[]; unfilled: string[]; draftWording: boolean };

const DRAFT_LINE = "טיוטה: הנוסח של התבנית הזאת עוד לא אושר על ידי עורך דין.";

/**
 * SGN-02: "מסמך לחתימה": pick an active template of the record's type, see the document filled with the record's details
 * (by the database), edit its free text (owner (224) ב: the template's locked sections are read-only, and the details from the
 * record must stay), then send it. The link is shown once (only its hash is kept): copy it or send it by WhatsApp then.
 */
export function SignatureSendPanel({ orgId, kind, recordId, templates, businessName, phoneE164 }: Props) {
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  // the sender's text of each segment (a locked one is never edited)
  const [texts, setTexts] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [days, setDays] = useState("");
  const [sent, setSent] = useState<{ url: string; title: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function preview(id: string) {
    setError(null);
    setPrepared(null);
    if (!id) return;
    startTransition(async () => {
      const result = await prepareSignatureDocumentAction(orgId, kind, recordId, id);
      if (!result.ok || !result.data) {
        setError(result.ok ? "לא הצלחנו להכין את המסמך." : result.message);
        return;
      }
      setPrepared({ templateId: id, ...result.data });
      setTexts(result.data.segments.map((segment) => segment.text));
      setTitle(result.data.title);
    });
  }

  function send() {
    if (!prepared) return;
    setError(null);
    startTransition(async () => {
      const body = prepared.segments.map((segment, index) => (segment.locked ? segment.text : (texts[index] ?? segment.text))).join("\n");
      const result = await sendSignatureDocumentAction(orgId, kind, recordId, prepared.templateId, title, body, days ? Number(days) : null);
      if (!result.ok || !result.data) {
        setError(result.ok ? "לא הצלחנו לשלוח את המסמך." : result.message);
        return;
      }
      setSent(result.data);
    });
  }

  async function copy(text: string) {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError("ההעתקה לא הצליחה. סמנו את הקישור והעתיקו ידנית.");
    }
  }

  function finish() {
    setSent(null);
    setPrepared(null);
    setCopied(false);
    setOpen(false);
    router.refresh();
  }

  if (sent) {
    return (
      <div className="space-y-3">
        <Label htmlFor={`${ids}-url`}>הקישור לחתימה</Label>
        <Input id={`${ids}-url`} dir="ltr" readOnly value={sent.url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
        <p className="text-sm text-ink-soft">הקישור מוצג רק עכשיו. שלחו אותו ללקוח: מי שיש לו את הקישור קורא את המסמך וחותם עליו.</p>
        <div className="flex flex-wrap gap-2">
          <a className={buttonClasses("secondary", "sm")} href={signatureWhatsappHref(sent.url, sent.title, businessName, phoneE164)} target="_blank" rel="noopener noreferrer">
            שליחה ב-WhatsApp
            <span className="sr-only"> (נפתח בחלון חדש)</span>
          </a>
          <Button size="sm" variant="secondary" onClick={() => void copy(sent.url)}>
            {copied ? "הועתק" : "העתקת הקישור"}
          </Button>
          <Button size="sm" variant="ghost" onClick={finish}>
            סיום
          </Button>
        </div>
        <FormError message={error} />
      </div>
    );
  }

  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        מסמך לחתימה
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      <SelectField
        label="תבנית"
        value={templateId}
        onChange={(event) => {
          setTemplateId(event.target.value);
          setPrepared(null);
        }}
      >
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </SelectField>
      {!prepared ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => preview(templateId)} loading={pending} disabled={!templateId}>
            הכנת המסמך
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            ביטול
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {prepared.draftWording ? <p className="text-sm text-ink-soft">{DRAFT_LINE}</p> : null}
          <div className="space-y-2" aria-live="polite">
            {prepared.segments.map((segment, index) =>
              segment.locked ? (
                <div key={index} className="rounded-md border border-line bg-canvas px-3 py-3">
                  <p className="mb-1 text-sm font-medium text-ink-soft">קטע נעול: אי אפשר לערוך אותו</p>
                  <NoteText text={segment.text} className="text-md text-ink" />
                </div>
              ) : (
                <TextareaField
                  key={index}
                  label={prepared.segments.length > 1 ? `טקסט לעריכה (${index + 1})` : "נוסח המסמך"}
                  value={texts[index] ?? segment.text}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setTexts((current) => current.map((text, at) => (at === index ? value : text)));
                  }}
                  rows={Math.min(12, Math.max(3, segment.text.split("\n").length + 1))}
                />
              ),
            )}
          </div>
          <p className="text-sm text-ink-soft">אפשר לערוך את הטקסט החופשי. הפרטים מהרשומה צריכים להישאר כפי שהם, והקטעים הנעולים לא משתנים.</p>
          {texts.some((text, index) => text !== prepared.segments[index]?.text) ? (
            <Button size="sm" variant="ghost" onClick={() => setTexts(prepared.segments.map((segment) => segment.text))} disabled={pending}>
              חזרה לנוסח המקורי
            </Button>
          ) : null}
          {prepared.unfilled.length > 0 ? (
            <p role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
              {`חסרים פרטים ברשומה: ${prepared.unfilled.join(", ")}. משלימים אותם ברשומה ואז שולחים.`}
            </p>
          ) : null}
          <TextField label="כותרת המסמך" value={title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={120} />
          <SelectField label="תוקף הקישור" value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="">בלי תאריך סיום</option>
            <option value="3">3 ימים</option>
            <option value="7">שבוע</option>
            <option value="14">שבועיים</option>
            <option value="30">30 ימים</option>
          </SelectField>
          <p className="text-sm text-ink-soft">המסמך נשמר כפי שהוא כאן, וזה הנוסח שהלקוח קורא וחותם עליו. שינוי ברשומה או בתבנית אחרי השליחה לא משנה אותו.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={send} loading={pending} disabled={prepared.unfilled.length > 0}>
              שליחה לחתימה
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPrepared(null)} disabled={pending}>
              חזרה
            </Button>
          </div>
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}
