"use client";

import { useActionState, useState } from "react";

import { Checkbox, SelectField, TextareaField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveBusinessPageAction } from "../actions";
import { MAX_ABOUT, MAX_PAGE_BOOKINGS, type PageRouting } from "../model";
import type { BusinessPageSettings } from "../queries";
import type { BusinessPageTexts } from "../texts";

export type BookingChoice = { id: string; title: string; repName: string; isActive: boolean };
export type RoutingOption = { id: string; name: string };

/** BIZ-01: what the business page shows, and whether it is on. The details themselves come from the business's settings. */
export function BusinessPageEditor({
  orgId,
  page,
  bookingPages,
  source,
  members,
  teams,
  texts,
}: {
  orgId: string;
  page: BusinessPageSettings | null;
  bookingPages: BookingChoice[];
  source: { phone: string | null; website: string | null; hasHours: boolean };
  members: RoutingOption[];
  teams: RoutingOption[];
  // the lead words in the business's terms (businessPageTexts, read on the server; RVW-94)
  texts: BusinessPageTexts;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(saveBusinessPageAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const picked = new Set(page?.bookingPageIds ?? []);
  const missing = (value: string | null | boolean, text: string) => (value ? undefined : text);
  const savedRouting: PageRouting = page?.ownerUserId ? "person" : page?.teamId ? "team" : "default";
  const [routing, setRouting] = useState<PageRouting>((values?.routing as PageRouting | undefined) ?? savedRouting);
  const routingChoice = (value: PageRouting, label: string) => (
    <label className="flex items-start gap-2.5 text-md">
      <input type="radio" name="routing" value={value} checked={routing === value} onChange={() => setRouting(value)} className="mt-1 size-4 accent-accent" />
      <span>{label}</span>
    </label>
  );

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
        <Checkbox name="show_form" label={texts.showForm} defaultChecked={page?.showForm ?? true} />
      </fieldset>
      <fieldset className="space-y-3 rounded-md border border-line p-3">
        <legend className="px-1 text-md font-medium">{texts.routingLegend}</legend>
        <div className="space-y-2">
          {routingChoice("default", texts.routingDefault)}
          {routingChoice("person", "לאדם אחד")}
          {routingChoice("team", "לצוות אחד")}
        </div>
        {routing === "person" ? (
          <SelectField
            label={texts.ownerLabel}
            name="owner_user_id"
            defaultValue={values?.owner_user_id ?? page?.ownerUserId ?? ""}
            error={failure?.fieldErrors?.owner_user_id}
            hint={texts.ownerHint}
          >
            <option value="">בחרו</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </SelectField>
        ) : null}
        {routing === "team" ? (
          <SelectField label="איזה צוות" name="team_id" defaultValue={values?.team_id ?? page?.teamId ?? ""} error={failure?.fieldErrors?.team_id} hint={texts.teamHint}>
            <option value="">בחרו</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                צוות {t.name}
              </option>
            ))}
          </SelectField>
        ) : null}
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
