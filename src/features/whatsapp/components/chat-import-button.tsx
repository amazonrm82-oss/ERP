"use client";

import { useState, useTransition } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { ChatIcon } from "@/components/ui/icons";
import type { TimelineSubject } from "@/features/activities/schema";

import { CHAT_ERRORS, CHAT_MAX_BYTES } from "../chat-import";
import { importWhatsappChatAction } from "../chat-import-actions";
import { chatTextFromZip, fileZipReader } from "../chat-zip";

type Props = { orgId: string; subject: TimelineSubject };

const isZip = (file: File) => /\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed";
const count = (n: number) => n.toLocaleString("he-IL");

/**
 * WAB-07: "ייבוא שיחת WhatsApp". The person picks the chat they exported from WhatsApp ("ייצוא צ'אט"):
 * the .txt file, or the .zip (only its text file is read here, in the browser; photos and videos in it
 * are never sent). The server reads the text and adds one entry to the timeline.
 */
export function ChatImportButton({ orgId, subject }: Props) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function openWindow() {
    setFile(null);
    setError(null);
    setDone(null);
    setOpen(true);
  }

  function submit() {
    if (!file) {
      setError(CHAT_ERRORS.no_file);
      return;
    }
    setError(null);
    start(async () => {
      let chat: Blob = file;
      if (isZip(file)) {
        const text = await chatTextFromZip(fileZipReader(file), file.size);
        if (!text.ok) {
          setError(text.reason === "not_zip" ? CHAT_ERRORS.not_whatsapp : CHAT_ERRORS[text.reason]);
          return;
        }
        chat = new Blob([text.bytes as BlobPart], { type: "text/plain" });
      } else if (file.size > CHAT_MAX_BYTES) {
        setError(CHAT_ERRORS.too_big);
        return;
      }
      const form = new FormData();
      form.set("chat", chat, "chat.txt");
      const answer = await importWhatsappChatAction(orgId, subject, form);
      if (!answer.ok) {
        setError(answer.message);
        return;
      }
      const summary = answer.data;
      setOpen(false);
      setDone(
        summary && summary.truncated
          ? `השיחה נוספה לציר הזמן: ${count(summary.kept)} ההודעות האחרונות מתוך ${count(summary.messages)}.`
          : `השיחה נוספה לציר הזמן${summary ? ` (${summary.messages === 1 ? "הודעה אחת" : `${count(summary.messages)} הודעות`})` : ""}.`,
      );
    });
  }

  return (
    <>
      <button type="button" className={buttonClasses("secondary", "sm")} onClick={openWindow} aria-haspopup="dialog">
        <ChatIcon className="size-4.5 text-accent" />
        ייבוא שיחת WhatsApp
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="ייבוא שיחת WhatsApp" description="השיחה נשמרת בציר הזמן כרשומה אחת" variant="sheet">
        <div className="space-y-4">
          <p className="text-sm text-ink-soft">
            ב-WhatsApp פותחים את השיחה, בוחרים &quot;עוד&quot; ואז &quot;ייצוא צ&apos;אט&quot;, ושומרים את הקובץ. אפשר להעלות את קובץ הטקסט או את קובץ ה-ZIP.
          </p>
          <TextField
            label="קובץ השיחה"
            type="file"
            accept=".txt,.zip,text/plain,application/zip"
            disabled={pending}
            hint="עד 900KB של טקסט. תמונות וקבצים מצורפים לא נשמרים, רק הטקסט של השיחה."
            onChange={(event) => {
              setError(null);
              setFile(event.target.files?.[0] ?? null);
            }}
          />
          <FormError message={error} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={submit} disabled={pending || !file}>
              {pending ? "מייבאים…" : "ייבוא לציר הזמן"}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              ביטול
            </Button>
          </div>
        </div>
      </Dialog>
      <span role="status" className="sr-only">
        {done ?? ""}
      </span>
      {done ? <p className="mt-1 text-sm text-ink-soft">{done}</p> : null}
    </>
  );
}
