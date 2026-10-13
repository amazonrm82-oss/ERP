"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/field";

import { createCalendarFeedAction, revokeCalendarFeedAction } from "../actions";

type Props = {
  orgId: string;
  active: boolean;
  // already formatted for the screen
  createdText: string;
  lastUsedText: string;
};

/**
 * CAL-07: the personal calendar link on "my account". The link is shown once,
 * right after it is made (only its hash is kept); after that the user can make
 * a new one (the old one stops working) or turn it off.
 */
export function CalendarFeedCard({ orgId, active, createdText, lastUsedText }: Props) {
  const router = useRouter();
  const inputId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setError(null);
    setCopied(false);
    const result = await createCalendarFeedAction(orgId);
    if (!result.ok) return result;
    setUrl(result.data?.url ?? null);
    return { ok: true as const };
  }

  async function createFirst() {
    setBusy(true);
    const result = await create();
    setBusy(false);
    if (!result.ok) setError(result.message);
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setError("ההעתקה לא הצליחה. סמנו את הקישור והעתיקו ידנית.");
    }
  }

  const webcal = url ? url.replace(/^https?:\/\//, "webcal://") : null;

  return (
    <div className="space-y-4">
      <p className="text-md">
        קישור אישי שמציג את הפגישות שלכם בעסק הזה ביומן של Google, ב-Outlook או בטלפון. היומן שם לקריאה בלבד: קובעים ומשנים כאן.
      </p>

      {url ? (
        <div className="space-y-3 rounded-md border border-line p-4">
          <Label htmlFor={inputId}>הקישור שלכם</Label>
          <Input id={inputId} dir="ltr" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
          <p className="text-sm text-ink-soft">הקישור מוצג רק עכשיו. הוסיפו אותו ליומן או שמרו אותו במקום בטוח. מי שיש לו את הקישור רואה את הפגישות שלכם.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void copy(url)}>
              {copied ? "הועתק" : "העתקת הקישור"}
            </Button>
            {webcal ? (
              <a href={webcal} className="inline-flex min-h-9 items-center rounded-md px-3 text-sm font-medium text-accent-strong underline underline-offset-4">
                פתיחה ביומן של הטלפון
              </a>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setUrl(null);
                router.refresh();
              }}
            >
              סיום
            </Button>
          </div>
        </div>
      ) : active ? (
        <div className="space-y-3">
          <p className="text-md">
            יש לכם קישור פעיל{createdText ? ` מאז ${createdText}` : ""}.
            {lastUsedText ? ` היומן נמשך לאחרונה ${lastUsedText}.` : " עוד לא נמשך."}
          </p>
          <div className="flex flex-wrap gap-2">
            <ConfirmButton
              variant="secondary"
              title="ליצור קישור חדש?"
              description="הקישור הקודם יפסיק לעבוד מיד, וצריך להוסיף את החדש ליומן במקומו."
              confirmLabel="יצירת קישור חדש"
              action={create}
            >
              קישור חדש
            </ConfirmButton>
            <ConfirmButton
              title="לבטל את הקישור?"
              description="הפגישות יפסיקו להתעדכן ביומנים שהקישור הוסף אליהם."
              confirmLabel="ביטול הקישור"
              action={revokeCalendarFeedAction.bind(null, orgId)}
              onDone={() => router.refresh()}
            >
              ביטול הקישור
            </ConfirmButton>
          </div>
        </div>
      ) : (
        <Button size="sm" onClick={() => void createFirst()} loading={busy}>
          יצירת קישור ליומן
        </Button>
      )}

      <FormError message={error} />

      <details className="rounded-md border border-line">
        <summary className="cursor-pointer px-4 py-2.5 text-md font-medium">איך מוסיפים את הקישור ליומן</summary>
        <ul className="list-disc space-y-2 px-4 pb-4 ps-8 text-md">
          <li>
            <span className="font-medium">Google Calendar:</span> במחשב, ליד &quot;יומנים אחרים&quot; לוחצים על +, בוחרים &quot;מכתובת URL&quot; ומדביקים את הקישור. היומן יופיע גם באפליקציה בטלפון.
          </li>
          <li>
            <span className="font-medium">Outlook:</span> &quot;הוספת יומן&quot;, ואז &quot;הרשמה מהאינטרנט&quot;, ומדביקים את הקישור.
          </li>
          <li>
            <span className="font-medium">iPhone:</span> לוחצים על &quot;פתיחה ביומן של הטלפון&quot; מיד אחרי יצירת הקישור, או בהגדרות: יומן, חשבונות, הוספת חשבון, אחר, &quot;הוספת יומן מנוי&quot;.
          </li>
        </ul>
        <p className="px-4 pb-4 text-sm text-ink-soft">היומנים האלה מתעדכנים בקצב שלהם, לפעמים רק אחת לכמה שעות. פגישה שבוטלה מסומנת כמבוטלת.</p>
      </details>
    </div>
  );
}
