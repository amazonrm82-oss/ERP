"use client";

import { useState, useTransition } from "react";

import { buttonClasses } from "@/components/ui/button";
import { ChatIcon } from "@/components/ui/icons";
import { WhatsappButton } from "@/features/whatsapp/components/whatsapp-button";
import { firstNameOf, type WhatsappListContext } from "@/features/whatsapp/templates";

import { loadCollectionReminderAction, type CollectionReminderMessage } from "../reminder-actions";
import { COLLECTION_REMINDER_TEXT } from "../reminders";

type Props = { orgId: string; taskId: string; context: WhatsappListContext };

/**
 * COL-04: the WhatsApp button of a collection reminder task. On a press it reads the document, its balance and the customer
 * (the user's session), then opens the WA-01 window with the collection template (or, when the business has no such template, the same text unsaved) filled in. The message
 * is sent by the person from their own WhatsApp and logged on the customer's timeline, like the record button.
 */
export function CollectionWhatsapp({ orgId, taskId, context }: Props) {
  const [message, setMessage] = useState<CollectionReminderMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();

  function load() {
    setError(null);
    startLoading(async () => {
      const answer = await loadCollectionReminderAction(orgId, taskId);
      if (answer.ok && answer.data) setMessage(answer.data);
      else setError(answer.ok ? null : answer.message);
    });
  }

  if (message?.state === "ready") {
    return (
      <WhatsappButton
        phoneE164={message.phoneE164}
        orgId={orgId}
        subject={message.subject}
        name={message.name}
        preselectId={message.templateId}
        fallbackText={message.templateId ? null : COLLECTION_REMINDER_TEXT}
        autoStart
        values={{
          firstName: message.firstName?.trim() || (message.subject.kind === "contact" ? firstNameOf(message.fullName) : null),
          fullName: message.fullName,
          userName: context.userName,
          businessName: context.businessName,
          document: message.document,
          amount: message.amount,
          dueDate: message.dueDate,
        }}
      />
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={buttonClasses("secondary", "sm")} onClick={load} disabled={loading} aria-haspopup="dialog">
        <ChatIcon className="size-4.5 text-accent" />
        <span>
          תזכורת ב-<span dir="ltr">WhatsApp</span>
        </span>
      </button>
      {loading ? <span className="text-sm text-ink-soft">טוענים…</span> : null}
      {message?.state === "paid" ? <span className="text-sm text-ink-soft">המסמך כבר שולם או בוטל. כשהחוב שולם, המערכת בדרך כלל סוגרת את המשימה בעצמה בדקות הקרובות; אפשר גם לסגור אותה עכשיו.</span> : null}
      {message?.state === "no_phone" ? <span className="text-sm text-ink-soft">אין מספר טלפון ל{message.name}.</span> : null}
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
