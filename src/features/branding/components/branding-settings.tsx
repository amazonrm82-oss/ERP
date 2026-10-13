"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useRef, useState, type CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Label, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { createClient } from "@/lib/supabase/client";

import { removeLogoAction, saveBrandColorAction, setLogoAction } from "../actions";
import { brandPalette, brandVars, DEFAULT_PICKER_COLOR, normalizeHex } from "../color";
import { LOGO_TYPES, LOGOS_BUCKET, logoFileProblem } from "../logo";
import { OrgLogo } from "./org-logo";

type Props = { orgId: string; logoUrl: string | null; color: string | null };

/** Logo and main colour of the business (FLD-04). Owners and admins; the page decides who sees it. */
export function BrandingSettings({ orgId, logoUrl, color }: Props) {
  return (
    <Card aria-labelledby="branding-title">
      <CardHeader id="branding-title" title="מיתוג העסק" />
      <CardBody className="space-y-6">
        <p className="text-sm text-ink-soft">
          הלוגו מופיע בראש המסך באפליקציה. הלוגו והצבע מופיעים בדפים שהלקוחות שלכם רואים, כמו טופס הפנייה.
        </p>
        <LogoPicker orgId={orgId} url={logoUrl} />
        <ColorForm orgId={orgId} color={color} />
      </CardBody>
    </Card>
  );
}

function LogoPicker({ orgId, url }: { orgId: string; url: string | null }) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    setStatus(null);
    const problem = logoFileProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const path = `${orgId}/${crypto.randomUUID()}`;
    const { error: uploadError } = await supabase.storage.from(LOGOS_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (uploadError) {
      setBusy(false);
      setError("ההעלאה נכשלה. נסו שוב.");
      return;
    }
    const result = await setLogoAction(orgId, path);
    if (!result.ok) {
      await supabase.storage.from(LOGOS_BUCKET).remove([path]);
      setError(result.message);
    } else {
      setStatus("הלוגו עודכן.");
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <section aria-labelledby={`${inputId}-title`} className="space-y-2">
      <h3 id={`${inputId}-title`} className="text-sm font-medium">
        לוגו
      </h3>
      <div className="flex flex-wrap items-center gap-4">
        <span className="flex h-16 w-32 shrink-0 items-center justify-center rounded-md border border-line bg-paper p-2">
          {url ? <OrgLogo url={url} alt="הלוגו של העסק" className="h-full max-w-full" /> : <span className="text-sm text-ink-soft">אין לוגו</span>}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={inputId}
            className={`inline-flex min-h-9 cursor-pointer items-center rounded-md border border-line-strong bg-surface px-3 text-sm font-medium hover:bg-canvas has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${busy ? "pointer-events-none opacity-60" : ""}`}
          >
            {busy ? "מעלים…" : url ? "החלפת לוגו" : "העלאת לוגו"}
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept={LOGO_TYPES.join(",")}
              disabled={busy}
              aria-describedby={`${inputId}-hint`}
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
          {url ? (
            <ConfirmButton
              title="להסיר את הלוגו?"
              description="הלוגו יוסר מהאפליקציה ומהדפים שהלקוחות רואים."
              confirmLabel="הסרה"
              action={removeLogoAction.bind(null, orgId)}
              onDone={() => router.refresh()}
              disabled={busy}
            >
              הסרת הלוגו
            </ConfirmButton>
          ) : null}
        </div>
      </div>
      <p id={`${inputId}-hint`} className="text-sm text-ink-soft">
        PNG, JPG או WebP, עד 1 MB. רקע שקוף נראה הכי טוב. כל מי שפותח את הטופס הציבורי רואה את הלוגו.
      </p>
      <p role="status" className="text-sm text-ink-soft">
        {status}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ColorForm({ orgId, color }: { orgId: string; color: string | null }) {
  const [state, formAction] = useActionState<FormState, FormData>(saveBrandColorAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const pickerId = useId();
  const [value, setValue] = useState(failure?.values?.brand_color ?? color ?? "");
  const hex = normalizeHex(value);
  const palette = hex ? brandPalette(hex) : null;

  return (
    <form action={formAction} className="space-y-3" noValidate>
      <h3 className="text-sm font-medium">צבע ראשי</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor={pickerId}>בחירה</Label>
          <input
            id={pickerId}
            type="color"
            value={hex ?? DEFAULT_PICKER_COLOR}
            onChange={(e) => setValue(e.target.value)}
            className="block h-11 w-16 cursor-pointer rounded-md border border-line-control bg-surface p-1"
          />
        </div>
        <TextField
          label="קוד הצבע"
          name="brand_color"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          maxLength={7}
          placeholder={DEFAULT_PICKER_COLOR}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={failure?.fieldErrors?.brand_color}
          className="w-36"
        />
      </div>

      {palette ? (
        <div
          className="space-y-2 rounded-md border border-line bg-canvas p-3"
          // the preview only: the business's colour, as the public pages will show it
          style={brandVars(palette) as CSSProperties}
          aria-label="תצוגה מקדימה"
          role="group"
        >
          <p className="text-sm text-ink-soft">כך ייראו כפתור וקישור בטופס הפנייה:</p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex min-h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-on-accent">שליחת הפרטים</span>
            <span className="text-sm font-medium text-accent underline underline-offset-4">קישור לדוגמה</span>
            <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-sm text-accent-strong">תגית</span>
          </div>
          {palette.corrected ? (
            <p className="text-sm text-ink-soft">
              הצבע הזה בהיר מדי לטקסט, ולכן בדפים יופיע גוון קרוב שקריא לכולם (נגישות).
            </p>
          ) : null}
        </div>
      ) : null}

      <FormError message={failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      <div className="flex flex-wrap gap-2">
        <SubmitButton>שמירת הצבע</SubmitButton>
        {color ? (
          <Button type="submit" variant="ghost" name="reset" value="1" onClick={() => setValue("")}>
            חזרה לצבע של המערכת
          </Button>
        ) : null}
      </div>
    </form>
  );
}
