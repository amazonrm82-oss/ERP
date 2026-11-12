"use client";

import { useActionState } from "react";

import { Checkbox, TextareaField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveBusinessPageAction } from "../actions";
import { MAX_ABOUT, MAX_PAGE_BOOKINGS } from "../model";
import type { BusinessPageSettings } from "../queries";

export type BookingChoice = { id: string; title: string; repName: string; isActive: boolean };

/** BIZ-01: what the business page shows, and whether it is on. The details themselves come from the business's settings. */
export function BusinessPageEditor({
  orgId,
  page,
  bookingPages,
  source,
}: {
  orgId: string;
  page: BusinessPageSettings | null;
  bookingPages: BookingChoice[];
  source: { phone: string | null; website: string | null; hasHours: boolean };
}) {
  const [state, formAction] = useActionState<FormState, FormData>(saveBusinessPageAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const picked = new Set(page?.bookingPageIds ?? []);
  const missing = (value: string | null | boolean, text: string) => (value ? undefined : text);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextareaField
        label="כמה מילים על העסק"
        name="about"
        rows={4}
        maxLength={MAX_ABOUT}
        defaultValue={values?.about ?? page?.about ?? ""}
        error={failure?.fieldErrors?.about}
        hint="מופיע מתחת לשם העסק. שם העסק, הלוגו והצבע נלקחים מפרטי העסק."
      />
      <fieldset className="space-y-2">
        <legend className="mb-1 text-md font-medium">מה מופיע בדף</legend>
        <p className="text-sm text-ink-soft">פרט ריק לא מופיע גם כשהוא מסומן. משנים את הפרטים עצמם בפרטי העסק ובשעות העבודה.</p>
        <Checkbox name="show_phone" label="טלפון העסק" hint={missing(source.phone, "אין טלפון בפרטי העסק.")} defaultChecked={page?.showPhone ?? true} />
        <Checkbox name="show_whatsapp" label="כפתור WhatsApp (לטלפון העסק)" hint={missing(source.phone, "אין טלפון בפרטי העסק.")} defaultChecked={page?.showWhatsapp ?? true} />
        <Checkbox name="show_website" label="אתר העסק" hint={missing(source.website, "אין אתר בפרטי העסק.")} defaultChecked={page?.showWebsite ?? true} />
        <Checkbox name="show_hours" label="שעות פעילות (שעות העבודה של העסק)" hint={missing(source.hasHours, "לא הוגדרו שעות עבודה לעסק.")} defaultChecked={page?.showHours ?? true} />
        <Checkbox name="show_form" label='טופס "צרו קשר" (כל פנייה נכנסת כליד, לפי חלוקת הלידים של העסק)' defaultChecked={page?.showForm ?? true} />
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-md font-medium">קביעת תור</legend>
        {bookingPages.length === 0 ? (
          <p className="text-sm text-ink-soft">אין עדיין דפי קביעת תור בעסק.</p>
        ) : (
          <>
            <p className="text-sm text-ink-soft">{`עד ${MAX_PAGE_BOOKINGS} דפים. דף כבוי או לא זמין לא מופיע.`}</p>
            {bookingPages.map((b) => (
              <Checkbox
                key={b.id}
                name="booking_page_ids"
                value={b.id}
                label={`${b.title} · ${b.repName}`}
                hint={b.isActive ? undefined : "הדף כבוי כרגע."}
                defaultChecked={picked.has(b.id)}
              />
            ))}
          </>
        )}
      </fieldset>
      <Checkbox name="is_active" label="הדף פעיל" hint={'כשהדף כבוי, הקישור מציג "הדף לא נמצא".'} defaultChecked={page?.isActive ?? false} />
      <SubmitButton>{page ? "שמירת הדף" : "יצירת הדף"}</SubmitButton>
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
    </form>
  );
}
