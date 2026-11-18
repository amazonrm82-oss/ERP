"use client";

import { useEffect, useId, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/field";
import type { TimelineSubject } from "@/features/activities/schema";
import { logWhatsappMessageAction } from "@/features/whatsapp/actions";
import { formatDate } from "@/lib/format";

import { createDocumentLinkAction, documentLinkStatusAction, revokeDocumentLinkAction, type DocumentLinkDormantReason, type DocumentLinkStatus } from "../link-actions";
import { documentLinkLogText, documentLinkMessage, documentMailtoHref, documentWhatsappHref } from "../share";

type Props = {
  orgId: string;
  documentId: string;
  // "חשבונית מס 1001"
  title: string;
  businessName: string;
  recipient: { name: string | null; phoneE164: string | null; email: string | null };
  // the record the WhatsApp message is logged on (the document's contact, else its deal); null = not logged
  logOn: TimelineSubject | null;
  // owner (413) ג: the business chose the invoicing provider to email documents it issued
  providerEmails: boolean;
  // the link's status and "ביטול הקישור" only (the plan lacks documents or the business is not writable): a link that exists
  // but does not open now is still seen and turned off, so it never comes back; nothing new is made
  manageOnly?: boolean;
};

const DORMANT: Record<DocumentLinkDormantReason, string> = {
  pages_closed: "הקישור לא פעיל כרגע: העסק לא פעיל.",
  feature_off: "הקישור לא פעיל כרגע: המודול כבוי בחבילה.",
  record_gone: "הקישור לא פעיל כרגע: הרשומה בסל המחזור או נמחקה.",
};

/**
 * DOC-15 (owner (414) א): "שליחה ללקוח" on a document row. A secret link to the customer's page of this document, shown once
 * (only its hash is kept), sent by WhatsApp (wa.me; the message goes on the record's timeline without the link) or by the
 * person's own email program, or copied. A new link replaces the old one; the link can be turned off.
 */
export function DocumentSendButton({ orgId, documentId, title, businessName, recipient, logOn, providerEmails, manageOnly = false }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`${manageOnly ? "קישור ללקוח" : "שליחה ללקוח"}: ${title}`}>
        {manageOnly ? "קישור ללקוח" : "שליחה ללקוח"}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`שליחת ${title} ללקוח`} variant="sheet">
        {open ? (
          <SendPanel
            orgId={orgId}
            documentId={documentId}
            title={title}
            businessName={businessName}
            recipient={recipient}
            logOn={logOn}
            providerEmails={providerEmails}
            manageOnly={manageOnly}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function SendPanel({ orgId, documentId, title, businessName, recipient, logOn, providerEmails, manageOnly, onDone }: Props & { onDone: () => void }) {
  const inputId = useId();
  const [status, setStatus] = useState<DocumentLinkStatus | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<"replace" | "revoke" | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void documentLinkStatusAction(orgId, documentId).then((result) => {
      if (!live) return;
      if (result.ok) setStatus(result.data ?? { exists: false, active: false, reason: null, createdAt: null });
      else setError(result.message);
    });
    return () => {
      live = false;
    };
  }, [orgId, documentId]);

  async function create() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setCopied(false);
    const result = await createDocumentLinkAction(orgId, documentId);
    setBusy(false);
    setAsking(null);
    if (!result.ok) return setError(result.message);
    setUrl(result.data?.url ?? null);
    setStatus({ exists: true, active: true, reason: null, createdAt: new Date().toISOString() });
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    const result = await revokeDocumentLinkAction(orgId, documentId);
    setBusy(false);
    setAsking(null);
    if (!result.ok) return setError(result.message);
    setUrl(null);
    setStatus({ exists: false, active: false, reason: null, createdAt: null });
    setNotice("הקישור בוטל. הלקוח לא יוכל לפתוח את המסמך ממנו.");
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

  async function logWhatsapp(link: string) {
    if (!logOn) return;
    const result = await logWhatsappMessageAction(orgId, logOn, { text: documentLinkLogText(link, title, businessName, recipient.name), templateId: null });
    if (!result.ok) setError(result.message);
  }

  return (
    <div className="space-y-4">
      {providerEmails && !manageOnly ? (
        <p className="text-sm text-ink-soft" role="note">
          לפי הגדרות העסק, ספק החשבוניות שולח את המסמכים שהופקו דרכו מהאימייל שלו. כאן אפשר לשלוח גם קישור ב-WhatsApp.
        </p>
      ) : null}
      {url ? (
        <div className="space-y-3">
          <Label htmlFor={inputId}>הקישור למסמך</Label>
          <Input id={inputId} dir="ltr" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
          <p className="text-sm text-ink-soft">הקישור מוצג רק עכשיו. מי שיש לו את הקישור רואה את המסמך, בלי להירשם.</p>
          <div className="flex flex-wrap gap-2">
            <a
              className={buttonClasses("secondary", "sm")}
              href={documentWhatsappHref(documentLinkMessage(url, title, businessName, recipient.name), recipient.phoneE164)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => void logWhatsapp(url)}
            >
              שליחה ב-WhatsApp
              <span className="sr-only"> (נפתח בחלון חדש)</span>
            </a>
            <a className={buttonClasses("secondary", "sm")} href={documentMailtoHref(url, title, businessName, recipient.name, recipient.email)}>
              שליחה מהאימייל שלכם
            </a>
            <Button size="sm" variant="secondary" onClick={() => void copy(url)}>
              {copied ? "הועתק" : "העתקת הקישור"}
            </Button>
          </div>
        </div>
      ) : status === null && !error ? (
        <p className="text-sm text-ink-soft" role="status">
          בודקים אם יש קישור…
        </p>
      ) : status?.exists ? (
        <div className="space-y-1">
          <p className="text-sm">
            יש למסמך קישור{status.createdAt ? ` מאז ${formatDate(status.createdAt)}` : ""}.
            {status.active && !manageOnly ? " הקישור מוצג רק כשיוצרים אותו; כדי לשלוח שוב, צרו קישור חדש." : " אפשר לבטל אותו, כדי שלא יחזור לעבוד."}
          </p>
          {status.active ? null : (
            <p className="text-sm text-warning" role="note">
              {status.reason ? DORMANT[status.reason] : "הקישור לא פעיל כרגע."}
            </p>
          )}
        </div>
      ) : status && manageOnly ? (
        <p className="text-sm">אין למסמך קישור פעיל.</p>
      ) : status ? (
        <p className="text-sm">קישור שהלקוח פותח בלי להירשם, ורואה בו את המסמך: הסכומים, השורות ומצב התשלום. אפשר להוריד ממנו את קובץ ה-PDF, כשיש למסמך כזה.</p>
      ) : null}

      {asking ? (
        <div className="space-y-2 rounded-md border border-line p-3">
          <p className="text-sm">
            {asking === "replace" ? "הקישור הקודם יפסיק לעבוד מיד. ליצור קישור חדש?" : "הלקוח לא יוכל לפתוח את המסמך מהקישור. לבטל אותו?"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={asking === "revoke" ? "danger" : "primary"} loading={busy} onClick={() => void (asking === "replace" ? create() : revoke())}>
              {asking === "replace" ? "יצירת קישור חדש" : "ביטול הקישור"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(null)} disabled={busy}>
              חזרה
            </Button>
          </div>
        </div>
      ) : status && !url ? (
        <div className="flex flex-wrap gap-2">
          {status.exists ? (
            <>
              {/* a new link only while the link opens now (and a new one could be made) */}
              {status.active && !manageOnly ? (
                <Button size="sm" variant="secondary" onClick={() => setAsking("replace")}>
                  קישור חדש
                </Button>
              ) : null}
              {/* shown whenever a link exists, also while it does not open now, so it can never come back */}
              <Button size="sm" variant="danger-ghost" onClick={() => setAsking("revoke")}>
                ביטול הקישור
              </Button>
            </>
          ) : manageOnly ? null : (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void create()}>
              יצירת קישור למסמך
            </Button>
          )}
        </div>
      ) : null}

      {notice ? (
        <p role="status" className="text-sm text-ink-soft">
          {notice}
        </p>
      ) : null}
      <FormError message={error} />
      <div className="pt-1">
        <Button variant="ghost" size="sm" onClick={onDone}>
          סיום
        </Button>
      </div>
    </div>
  );
}
