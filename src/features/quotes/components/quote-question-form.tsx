"use client";

import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextareaField } from "@/components/ui/field";

import { QUESTION_MAX } from "../decision";

/**
 * QUO-08 (owner, 1 November 2026, answer (28) א): on the customer's page, a short question to the rep (up to 500 characters).
 * It goes to the quote's owner as a notice and onto the timeline; the server limits how often.
 */
export function QuoteQuestionForm({ token }: { token: string }) {
  const ids = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const trimmed = text.trim();

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-3 rounded-lg border border-line bg-surface p-4 print:hidden sm:p-6">
      <h2 id={`${ids}-title`} className="text-lg font-semibold text-ink">
        שאלה לנציג
      </h2>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length === 0 || trimmed.length > QUESTION_MAX) return;
          setError(null);
          setNotice(null);
          startTransition(async () => {
            try {
              const response = await fetch(`/api/forms/quote/${encodeURIComponent(token)}/question`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: trimmed }),
              });
              const answer = (await response.json()) as { ok: boolean; message: string };
              if (answer.ok) {
                setNotice(answer.message);
                setText("");
              } else {
                setError(answer.message);
              }
            } catch {
              setError("אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב.");
            }
          });
        }}
      >
        <TextareaField
          label="מה תרצו לשאול?"
          hint={`עד ${QUESTION_MAX} תווים. התשובה תגיע מהעסק ששלח את ההצעה.`}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          maxLength={QUESTION_MAX}
          rows={3}
          required
        />
        <FormError message={error} />
        {notice ? <FormNotice message={notice} /> : null}
        <Button type="submit" variant="secondary" loading={pending} disabled={trimmed.length === 0}>
          שליחת השאלה
        </Button>
      </form>
    </section>
  );
}
