"use client";

import { useId, useState, useTransition } from "react";

import { FormError } from "@/components/ui/feedback";
import { saveThemeAction } from "@/features/profile/actions";

import { applyThemeChoice, THEME_CHOICES, THEME_LABELS, type ThemeChoice } from "../theme";

/** USR-07: "מראה" in "החשבון שלי". The page changes at once; the choice is saved for every business and this device. */
export function ThemePicker({ orgId, initial }: { orgId: string; initial: ThemeChoice }) {
  const [choice, setChoice] = useState<ThemeChoice>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const name = useId();

  function pick(next: ThemeChoice) {
    const before = choice;
    setChoice(next);
    setError(null);
    applyThemeChoice(next, document.documentElement, window.matchMedia("(prefers-color-scheme: dark)").matches);
    startTransition(async () => {
      const result = await saveThemeAction(orgId, next);
      if (!result.ok) {
        // put the page back as it was saved
        setChoice(before);
        applyThemeChoice(before, document.documentElement, window.matchMedia("(prefers-color-scheme: dark)").matches);
        setError(result.message);
      }
    });
  }

  return (
    <fieldset className="space-y-2" aria-busy={pending || undefined}>
      <legend className="text-sm font-medium">מראה</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {THEME_CHOICES.map((value) => (
          <label key={value} className="flex min-h-11 items-center gap-2">
            <input type="radio" name={name} value={value} checked={choice === value} onChange={() => pick(value)} className="size-5 accent-accent" />
            {THEME_LABELS[value]}
          </label>
        ))}
      </div>
      <p className="text-sm text-ink-soft">&quot;לפי המכשיר&quot; עובר לכהה כשהמכשיר במצב כהה. הבחירה נשמרת לכל העסקים.</p>
      <FormError message={error} />
    </fieldset>
  );
}
