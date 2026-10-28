"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { Button, buttonClasses, iconButtonClasses } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { TextareaField } from "@/components/ui/field";
import { ChatIcon } from "@/components/ui/icons";
import type { TimelineSubject } from "@/features/activities/schema";

import { loadWhatsappTemplatesAction, logWhatsappMessageAction, type TemplateChoice } from "../actions";
import { fillTemplate, MESSAGE_MAX, missingPlaceholders, whatsappMessageUrl, type TemplateValues } from "../templates";

type Props = {
  phoneE164: string;
  orgId: string;
  subject: TimelineSubject;
  // the record's display name, for the window's title
  name: string;
  // what the placeholders of a template become on this record
  values: TemplateValues;
  // GAP-03: the template chosen when the window opens (the meeting reminder); one that is
  // gone by then is simply not chosen, and the window offers the rest
  preselectId?: string | null;
  // COL-04: the text offered (unsaved, as "בלי תבנית") when there is no template to preselect
  fallbackText?: string | null;
  // SPD-01: full width and 44px tall (the short new-lead screen)
  wide?: boolean;
  // SPD-01: open the window once on arrival ("WhatsApp" pressed on the push)
  autoStart?: boolean;
  // WA-01 follow-up: a 44px icon in a list row, named after the person
  iconOnly?: boolean;
};

const NO_TEMPLATE = "";

/**
 * WA-01: the record's WhatsApp button. It offers the organization's templates, fills them,
 * lets the person change the text, opens wa.me with it, and logs the message on the
 * timeline. One message, sent by the person from their own WhatsApp; nothing is sent by us.
 */
export function WhatsappButton({ phoneE164, orgId, subject, name, values, preselectId = null, fallbackText = null, wide, autoStart, iconOnly }: Props) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateChoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState(NO_TEMPLATE);
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loading, startLoading] = useTransition();
  const [, startLogging] = useTransition();

  function choose(list: TemplateChoice[], id: string) {
    setChoice(id);
    const template = list.find((item) => item.id === id);
    setText(template ? fillTemplate(template.body, values) : "");
  }

  function openWindow() {
    setResult(null);
    setOpen(true);
    if (templates === null) {
      setLoadError(null);
      startLoading(async () => {
        const answer = await loadWhatsappTemplatesAction(orgId);
        if (answer.ok) {
          const list = answer.data ?? [];
          setTemplates(list);
          if (preselectId && list.some((item) => item.id === preselectId)) choose(list, preselectId);
          else if (fallbackText) setText(fillTemplate(fallbackText, values));
        } else setLoadError(answer.message);
      });
    } else if (preselectId && choice === NO_TEMPLATE && text === "" && templates.some((item) => item.id === preselectId)) {
      choose(templates, preselectId);
    }
  }

  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    // after the first paint, like a press of the button
    const timer = setTimeout(openWindow, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, [autoStart]);

  function pick(id: string) {
    choose(templates ?? [], id);
  }

  const tooLong = text.trim().length > MESSAGE_MAX;
  const missing = missingPlaceholders(text);
  const url = whatsappMessageUrl(phoneE164, text);

  // The link opens WhatsApp by itself (its default action). Closing the window would unmount
  // the link, so it waits until the browser has followed it (as the call button does, TASK-02);
  // the message is logged only after that attempt.
  function sent() {
    const message = { text, templateId: choice === NO_TEMPLATE ? null : choice };
    setTimeout(() => {
      setOpen(false);
      setChoice(NO_TEMPLATE);
      setText("");
      startLogging(async () => {
        const answer = await logWhatsappMessageAction(orgId, subject, message);
        setResult(answer.ok ? { ok: true, message: "ההודעה נרשמה בציר הזמן." } : { ok: false, message: answer.message });
      });
    }, 0);
  }

  return (
    <>
      {iconOnly ? (
        <button
          type="button"
          className={iconButtonClasses("secondary")}
          onClick={openWindow}
          aria-haspopup="dialog"
          aria-label={`הודעת WhatsApp אל ${name}`}
          title="הודעת WhatsApp"
        >
          <ChatIcon aria-hidden="true" className="size-5 text-accent" />
        </button>
      ) : (
        <button
          type="button"
          className={wide ? buttonClasses("secondary", "md", "w-full") : buttonClasses("secondary", "sm")}
          onClick={openWindow}
          aria-haspopup="dialog"
        >
          <ChatIcon className="size-4.5 text-accent" />
          <span dir="ltr">WhatsApp</span>
        </button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="הודעת WhatsApp" description={`אל ${name}`} variant="sheet">
        <div className="space-y-4">
          <FormError message={loadError} />
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">תבנית</legend>
            {loading && templates === null ? <p className="text-sm text-ink-soft">טוענים תבניות…</p> : null}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {[{ id: NO_TEMPLATE, name: "בלי תבנית" }, ...(templates ?? [])].map((option) => (
                <label
                  key={option.id || "none"}
                  className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 py-2 has-checked:border-accent has-checked:bg-accent-soft"
                >
                  <input type="radio" name="whatsapp-template" value={option.id} checked={choice === option.id} onChange={() => pick(option.id)} />
                  <span className="min-w-0 break-words">{option.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <TextareaField
            label="ההודעה"
            rows={5}
            value={text}
            onChange={(event) => setText(event.target.value)}
            hint={missing.length > 0 ? `יש להשלים לפני השליחה: ${missing.join(", ")}` : "אפשר לשנות את הנוסח לפני השליחה."}
            error={tooLong ? `ההודעה ארוכה מדי (עד ${MESSAGE_MAX.toLocaleString("he-IL")} תווים).` : undefined}
          />
          <p className="text-sm text-ink-soft">ההודעה נשלחת מה-WhatsApp שלכם, ונרשמת בציר הזמן של הרשומה.</p>
          <div className="flex flex-wrap gap-2">
            {url && !tooLong ? (
              <a href={url} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary")} onClick={sent}>
                <ChatIcon className="size-5" />
                פתיחה ב-WhatsApp
                <span className="sr-only">(נפתח בחלון חדש)</span>
              </a>
            ) : (
              <Button disabled>
                <ChatIcon className="size-5" />
                פתיחה ב-WhatsApp
              </Button>
            )}
            <Button variant="ghost" onClick={() => setOpen(false)}>
              ביטול
            </Button>
          </div>
        </div>
      </Dialog>
      {result && !result.ok ? (
        <p role="alert" className="mt-1 text-sm text-danger">
          {result.message}
        </p>
      ) : null}
      <span role="status" className="sr-only">
        {result?.ok ? result.message : ""}
      </span>
    </>
  );
}
