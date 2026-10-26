"use client";

import { useActionState, useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Input, Label, SelectField, Textarea, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import type { Json } from "@/lib/database.types";

import { createIntakeAction, updateIntakeAction } from "../actions";
import { CALLBACK_SLOTS, slotInputName, slotLabel } from "../callback";
import { parseFieldsConfig, storedFields, type FormFieldConfig, type FormFieldOption } from "../fields";
import {
  addressField,
  MARKETING_CONSENT_CHANNELS,
  MARKETING_CONSENT_DRAFT_NOTE,
  MARKETING_CONSENT_INPUT,
  MARKETING_CONSENT_LABELS,
  marketingConsentWording,
} from "../marketing-consent";
import {
  CATEGORY_PICKS_VALUE,
  initialProductPicks,
  MAX_FORM_PRODUCTS,
  PRODUCTS_ALL_OVER,
  PRODUCTS_GREW_WARNING,
  PRODUCTS_KEPT_SAVED,
  PRODUCTS_NARROW_VALUE,
  PRODUCTS_NEEDS_NARROWING,
  selectionNeedsNarrowing,
  type FormCategory,
  type FormProduct,
} from "../product";
import { FormFieldsBuilder } from "./form-fields-builder";
import type { IntakeDetails } from "../queries";

type Option = { id: string; name: string };

export function CreateIntakeForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(createIntakeAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-start">
        <TextField
          label="שם"
          name="name"
          required
          maxLength={80}
          autoComplete="off"
          placeholder="למשל: טופס צור קשר באתר"
          defaultValue={failure?.values?.name}
          error={failure?.fieldErrors?.name}
        />
        <SelectField label="סוג" name="kind" defaultValue={failure?.values?.kind ?? "form"}>
          <option value="form">טופס לאתר</option>
          <option value="webhook">Webhook</option>
        </SelectField>
        <SubmitButton className="sm:mt-6.5" pendingText="יוצרים…">
          יצירה
        </SubmitButton>
      </div>
    </form>
  );
}

// businessPhone: the business phone as typed, when a WhatsApp chat can open it, else null (CAP-05)
type EditProps = {
  orgId: string;
  intake: IntakeDetails;
  sources: Option[];
  members: Option[];
  teams: Option[];
  fieldOptions: FormFieldOption[];
  businessPhone: string | null;
  // CAP-07 / CNS-04: the business's display name, for the consent box's wording
  businessName?: string;
  // LEAD-04 / CAP-08: what the product question offers to pick; null when the business has no products flag
  productChoices?: ProductChoices | null;
};

/** LEAD-04 / CAP-08: the product question's lists and counts, read by the settings page. */
export type ProductChoices = {
  // offerable products to pick, in the public form's order (stored picks always included)
  options: FormProduct[];
  // the catalog holds more offerable products than the list shows
  cut: boolean;
  categories: Array<FormCategory & { depth: 0 | 1 }>;
  // offerable products of the business, and of the form's saved choice
  offerable: number;
  offer: number;
};

/** The builder's JSON (camelCase) in the stored shape, for parseFieldsConfig. */
function fieldsJsonToStored(json: string): Json {
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? storedFields(list as FormFieldConfig[]) : [];
  } catch {
    return [];
  }
}

export function IntakeSettingsForm({
  orgId,
  intake,
  sources,
  members,
  teams,
  fieldOptions,
  businessPhone,
  businessName = "",
  productChoices = null,
}: EditProps) {
  const [state, formAction] = useActionState<FormState, FormData>(updateIntakeAction.bind(null, orgId, intake.id), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const isForm = intake.kind === "form";
  // after a failed save, the builder starts from what was sent
  const builderInitial = values?.fields_json ? parseFieldsConfig(fieldsJsonToStored(values.fields_json)) : intake.fields;
  const sourceValue = values?.source_id ?? intake.sourceId ?? "";
  const ownerValue = values?.owner_id ?? intake.ownerId ?? "";
  const teamValue = values?.team_id ?? intake.teamId ?? "";
  const [mode, setMode] = useState(values?.assign_mode ?? intake.assignMode);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <TextField label="שם פנימי" name="name" required maxLength={80} autoComplete="off" defaultValue={values?.name ?? intake.name} error={errors.name} />

      {isForm ? (
        <>
          <TextField label="כותרת הטופס" name="title" maxLength={120} autoComplete="off" defaultValue={values?.title ?? intake.title ?? ""} error={errors.title} />
          <TextareaField label="טקסט מעל הטופס (לא חובה)" name="intro" rows={2} maxLength={500} defaultValue={values?.intro ?? intake.intro ?? ""} error={errors.intro} />
          <FormFieldsBuilder key={values?.fields_json ?? "saved"} initial={builderInitial} options={fieldOptions} />
          <CallbackSettings intake={intake} values={values} />
          <ChannelSettings intake={intake} values={values} />
          <LocaleSettings intake={intake} values={values} />
          <MarketingConsentSettings intake={intake} values={values} businessName={businessName} fieldKeys={builderInitial.map((field) => field.key)} />
          {productChoices ? <ProductSettings intake={intake} values={values} choices={productChoices} error={errors.product_ids} /> : null}
          <TextField label="טקסט הכפתור" name="submit_label" maxLength={40} autoComplete="off" placeholder="שליחת הפרטים" defaultValue={values?.submit_label ?? intake.submitLabel ?? ""} error={errors.submit_label} />
          <ThanksSettings intake={intake} businessPhone={businessPhone} values={values} errors={errors} />
        </>
      ) : null}

      <SelectField key={`source-${sourceValue}`} label="מקור הליד" name="source_id" defaultValue={sourceValue} error={errors.source_id}>
        <option value="">ללא מקור</option>
        {sources.map((source) => (
          <option key={source.id} value={source.id}>
            {source.name}
          </option>
        ))}
      </SelectField>

      <fieldset className="space-y-4 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-medium">למי הולך ליד חדש</legend>
        <div className="space-y-2">
          <label className="flex items-start gap-2.5 text-md">
            <input
              type="radio"
              name="assign_mode"
              value="owner"
              checked={mode === "owner"}
              onChange={() => setMode("owner")}
              className="mt-1 size-4 accent-accent"
            />
            <span>לחבר צוות קבוע</span>
          </label>
          <label className="flex items-start gap-2.5 text-md">
            <input
              type="radio"
              name="assign_mode"
              value="round_robin"
              checked={mode === "round_robin"}
              onChange={() => setMode("round_robin")}
              className="mt-1 size-4 accent-accent"
            />
            <span>
              בסבב בין חברי הצוות הזמינים
              <span className="block text-sm text-ink-soft">כל ליד הולך למי שקיבל ליד הכי מזמן. מי שסימן שהוא לא זמין מדולג.</span>
            </span>
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {/* the lead's team; in a round robin also who takes part. A lead nobody owns is offered to this team (SPD-01) */}
          <SelectField
            key={`team-${teamValue}`}
            label={mode === "round_robin" ? "מי משתתף בסבב" : "הצוות של הליד"}
            name="team_id"
            defaultValue={teamValue}
            error={errors.team_id}
          >
            <option value="">{mode === "round_robin" ? "כל המשתמשים בעסק" : "ללא צוות"}</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                צוות {team.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            key={`owner-${ownerValue}`}
            label={mode === "round_robin" ? "אם אף אחד לא זמין" : "חבר הצוות"}
            name="owner_id"
            defaultValue={ownerValue}
            error={errors.owner_id}
            hint='בלי אחראי: ההתראה נשלחת לכל הצוות של הליד (בלי צוות: לבעלים ולמנהלי המערכת), והראשון שלוחץ "לקחתי" מקבל אותו.'
          >
            <option value="">ללא אחראי</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </SelectField>
        </div>
      </fieldset>
      <label className="flex items-center gap-2.5 text-md">
        <input type="checkbox" name="is_active" defaultChecked={values ? values.is_active === "on" : intake.isActive} className="size-4.5 accent-accent" />
        פעיל (מקבל פניות)
      </label>
      <FormError message={failure && (!failure.fieldErrors || failure.message === PRODUCTS_KEPT_SAVED) ? failure.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}

/**
 * SPD-05: ask when to call back, and which slots to offer (all on by default).
 * The form shows "now" from 08:00 to 20:00 and the slots of today and of the
 * next working day; a switched-off slot is never offered.
 */
function CallbackSettings({ intake, values }: { intake: IntakeDetails; values?: Record<string, string> }) {
  const [on, setOn] = useState(values ? values.callback_choice === "on" : intake.callbackChoice);
  const legendId = useId();
  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2.5 text-md">
        <input
          type="checkbox"
          name="callback_choice"
          checked={on}
          onChange={(event) => setOn(event.target.checked)}
          className="mt-1 size-4.5 accent-accent"
        />
        <span>
          לשאול מתי נוח שנחזור
          <span className="block text-sm text-ink-soft">
            עכשיו (בין 8:00 ל-20:00), או שעה היום או ביום העבודה הבא. כל בחירה יוצרת משימת שיחה למי שמטפל בליד, ומופיעה בהתראה.
          </span>
        </span>
      </label>
      {on ? (
        <fieldset aria-labelledby={legendId} className="space-y-2 rounded-md border border-line p-3 ms-7">
          <legend id={legendId} className="px-1 text-sm font-medium">
            שעות שמוצעות בטופס
          </legend>
          <p className="text-sm text-ink-soft">
            ביום מנוחה של העסק מוצג רק יום העבודה הבא. ביום שישי, בערב חג וביום הזיכרון, כשלמחרת יום מנוחה, מוצגות רק השעות עד 15:00, ואחר כך רק יום
            העבודה הבא.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CALLBACK_SLOTS.map((slot) => {
              const name = slotInputName(slot.start);
              return (
                <label key={slot.start} className="flex items-center gap-2 text-md">
                  <input
                    type="checkbox"
                    name={name}
                    defaultChecked={values ? values[name] === "on" : !intake.callbackSlotsOff.includes(slot.start)}
                    className="size-4.5 accent-accent"
                  />
                  <span dir="ltr">{slotLabel(slot)}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

/** CON-10: ask how the person likes to be contacted; the answer fills the preferred channel (never one a person set). */
function ChannelSettings({ intake, values }: { intake: IntakeDetails; values?: Record<string, string> }) {
  return (
    <label className="flex items-start gap-2.5 text-md">
      <input
        type="checkbox"
        name="channel_choice"
        defaultChecked={values ? values.channel_choice === "on" : intake.channelChoice}
        className="mt-1 size-4.5 accent-accent"
      />
      <span>
        לשאול איך נוח שניצור קשר
        <span className="block text-sm text-ink-soft">
          טלפון, וואטסאפ, אימייל או SMS. התשובה נשמרת כערוץ המועדף של הליד. ערוץ שמישהו בצוות קבע לא משתנה.
        </span>
      </span>
    </label>
  );
}

/**
 * CAP-07 / CNS-04: an unticked marketing-consent box per channel. A box shows on the form only while the form asks for
 * its address (email; phone for SMS and WhatsApp). A tick is recorded as the person's consent with this wording and its
 * version. The wording is a DRAFT until the lawyer edits it.
 */
function MarketingConsentSettings({
  intake,
  values,
  businessName,
  fieldKeys,
}: {
  intake: IntakeDetails;
  values?: Record<string, string>;
  businessName: string;
  fieldKeys: string[];
}) {
  const legendId = useId();
  return (
    <fieldset aria-labelledby={legendId} className="space-y-2 rounded-md border border-line p-3">
      <legend id={legendId} className="px-1 text-md font-medium">
        הסכמה לדיוור
      </legend>
      <p className="text-sm text-ink-soft">
        תיבה לא מסומנת לכל ערוץ. מי שמסמן נרשם כמי שהסכים לקבל דיוור בערוץ הזה, עם הנוסח ותאריך. בלי סימון לא נרשם כלום.
      </p>
      {MARKETING_CONSENT_CHANNELS.map((channel) => {
        const name = `${MARKETING_CONSENT_INPUT}_${channel}`;
        const collected = fieldKeys.includes(addressField(channel));
        return (
          <label key={channel} className="flex items-start gap-2.5 text-md">
            <input
              type="checkbox"
              name={name}
              defaultChecked={values ? values[name] === "on" : intake.marketingConsentChannels.includes(channel)}
              className="mt-1 size-4.5 shrink-0 accent-accent"
            />
            <span>
              {MARKETING_CONSENT_LABELS[channel]}
              <span className="block text-sm text-ink-soft">{marketingConsentWording(channel, businessName)}</span>
              {collected ? null : (
                <span className="block text-sm text-ink-soft">
                  {channel === "email" ? "מוצג רק כשהטופס מבקש אימייל." : "מוצג רק כשהטופס מבקש טלפון."}
                </span>
              )}
            </span>
          </label>
        );
      })}
      <p className="text-sm text-ink-soft">{MARKETING_CONSENT_DRAFT_NOTE}</p>
    </fieldset>
  );
}

/** CAP-08: ask the person's preferred language; the answer fills the lead's language (never a set one). */
function LocaleSettings({ intake, values }: { intake: IntakeDetails; values?: Record<string, string> }) {
  return (
    <label className="flex items-start gap-2.5 text-md">
      <input
        type="checkbox"
        name="locale_choice"
        defaultChecked={values ? values.locale_choice === "on" : intake.localeChoice}
        className="mt-1 size-4.5 accent-accent"
      />
      <span>
        לשאול באיזו שפה נוח לדבר
        <span className="block text-sm text-ink-soft">
          עברית, ערבית, אנגלית, רוסית, אמהרית, צרפתית או ספרדית. התשובה נשמרת כשפה המועדפת של הליד, וכללי חלוקת לידים יכולים לשלוח לפיה.
        </span>
      </span>
    </label>
  );
}

/**
 * LEAD-04 / CAP-08: ask which product the person is interested in. The answer is the new lead's requested product, set
 * before the distribution rules, so a rule by product applies. Every offerable product (only while the business has at
 * most 100), or the picked products and categories (a top category includes its sub-categories). The inputs stay in the
 * form while the question is off (hidden), so turning it off keeps the picks.
 */
function ProductSettings({
  intake,
  values,
  choices,
  error,
}: {
  intake: IntakeDetails;
  values?: Record<string, string>;
  choices: ProductChoices;
  error?: string;
}) {
  const storedScope = intake.productIds || intake.productCategoryIds ? "picked" : "all";
  // "all" may be picked while the business has at most 100; over that, it stays selectable only as the stored choice
  // (owner, 26 October 2026: an unchanged selection keeps saving; it is marked "דורש צמצום")
  const allAllowed = choices.offerable <= MAX_FORM_PRODUCTS;
  const allSelectable = allAllowed || (intake.productChoice && storedScope === "all");
  const [on, setOn] = useState(values ? values.product_choice === "on" : intake.productChoice);
  const [scope, setScope] = useState(values?.product_scope ?? (allSelectable ? storedScope : "picked"));
  const legendId = useId();
  const errorId = useId();
  // after a failed save, the ticks the person sent; otherwise the stored picks
  const picked = initialProductPicks(values, intake.productIds);
  const pickedCategories = initialProductPicks(values, intake.productCategoryIds, CATEGORY_PICKS_VALUE);
  // the saved choice offers more than 100 today (the business or a category grew): the form shows the first 100;
  // or a changed choice over 100 was just left out of a save
  const grew = selectionNeedsNarrowing(intake.productChoice, choices.offer);
  const narrow = grew || values?.[PRODUCTS_NARROW_VALUE] === "1";
  return (
    <div className="space-y-3">
      <input type="hidden" name="product_settings" value="1" />
      <label className="flex items-start gap-2.5 text-md">
        <input
          type="checkbox"
          name="product_choice"
          checked={on}
          onChange={(event) => setOn(event.target.checked)}
          className="mt-1 size-4.5 accent-accent"
        />
        <span>
          לשאול במה מתעניינים
          <span className="block text-sm text-ink-soft">
            רשימה של מוצרים מהקטלוג, בלי מחירים. הבחירה נשמרת כמוצר המבוקש של הליד, וכללי חלוקת לידים לפי מוצר חלים עליה.
          </span>
        </span>
      </label>
      {narrow ? (
        <div role="note" className="space-y-1.5 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning ms-7">
          <Badge tone="warning">{PRODUCTS_NEEDS_NARROWING}</Badge>
          {grew ? <p>{PRODUCTS_GREW_WARNING}</p> : null}
        </div>
      ) : null}
      <fieldset
        hidden={!on}
        aria-labelledby={legendId}
        aria-describedby={error ? errorId : undefined}
        className="space-y-2 rounded-md border border-line p-3 ms-7"
      >
        <legend id={legendId} className="px-1 text-sm font-medium">
          אילו מוצרים להציג
        </legend>
        {choices.offerable === 0 ? <p className="text-sm text-ink-soft">אין בקטלוג מוצרים פעילים, ולכן השאלה לא תוצג בטופס.</p> : null}
        <label className="flex items-start gap-2 text-md">
          <input
            type="radio"
            name="product_scope"
            value="all"
            checked={scope === "all"}
            disabled={!allSelectable}
            onChange={() => setScope("all")}
            className="mt-1 size-4.5 accent-accent"
          />
          <span>
            כל המוצרים הפעילים
            {allAllowed ? null : <span className="block text-sm text-ink-soft">{PRODUCTS_ALL_OVER}</span>}
          </span>
        </label>
        <label className="flex items-center gap-2 text-md">
          <input
            type="radio"
            name="product_scope"
            value="picked"
            checked={scope === "picked"}
            onChange={() => setScope("picked")}
            className="size-4.5 accent-accent"
          />
          רק המוצרים והקטגוריות שאבחר (עד {MAX_FORM_PRODUCTS} מוצרים בסך הכול)
        </label>
        <div hidden={scope !== "picked"} className="space-y-3 ms-7">
          {choices.categories.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">קטגוריות</p>
              <p className="text-sm text-ink-soft">קטגוריה ראשית כוללת גם את קטגוריות המשנה שלה.</p>
              <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border border-line p-2">
                {choices.categories.map((category) => (
                  <label key={category.id} className={`flex items-start gap-2 text-md break-words ${category.depth === 1 ? "ps-6" : ""}`}>
                    <input
                      type="checkbox"
                      name="product_category_ids"
                      value={category.id}
                      defaultChecked={pickedCategories.has(category.id)}
                      className="mt-1 size-4.5 shrink-0 accent-accent"
                    />
                    <span className="min-w-0">{category.name}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <p className="text-sm font-medium">מוצרים</p>
            <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-line p-2">
              {choices.options.map((product) => (
                <label key={product.id} className="flex items-start gap-2 text-md break-words">
                  <input
                    type="checkbox"
                    name="product_ids"
                    value={product.id}
                    defaultChecked={picked.has(product.id)}
                    className="mt-1 size-4.5 shrink-0 accent-accent"
                  />
                  <span className="min-w-0">{product.name}</span>
                </label>
              ))}
              {choices.cut ? <p className="text-sm text-ink-soft">מוצגים 500 המוצרים הראשונים לפי שם, ומוצרים שכבר נבחרו.</p> : null}
            </div>
          </div>
        </div>
        {error ? (
          <p id={errorId} className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}

/**
 * CAP-05: what the person sees after sending: the thank-you message, with an
 * optional WhatsApp button, or a page of the business's own (which wins).
 */
function ThanksSettings({
  intake,
  businessPhone,
  values,
  errors,
}: {
  intake: IntakeDetails;
  businessPhone: string | null;
  values: Record<string, string> | undefined;
  errors: Record<string, string>;
}) {
  const [whatsapp, setWhatsapp] = useState(values ? values.whatsapp_button === "on" : intake.whatsappButton);
  return (
    <fieldset className="space-y-4 rounded-md border border-line p-3">
      <legend className="px-1 text-sm font-medium">אחרי השליחה</legend>
      <TextField
        label="הודעת תודה"
        name="success_message"
        maxLength={300}
        autoComplete="off"
        placeholder="תודה! קיבלנו את הפרטים ונחזור אליכם בהקדם."
        defaultValue={values?.success_message ?? intake.successMessage ?? ""}
        error={errors.success_message}
      />
      <div className="space-y-3">
        <label className="flex items-start gap-2.5 text-md">
          <input
            type="checkbox"
            name="whatsapp_button"
            checked={whatsapp}
            onChange={(event) => setWhatsapp(event.currentTarget.checked)}
            className="mt-1 size-4.5 accent-accent"
          />
          <span>
            כפתור WhatsApp בהודעת התודה
            <span className="block text-sm text-ink-soft">מי שמילא את הטופס יכול לפתוח שיחה עם העסק בלחיצה.</span>
          </span>
        </label>
        {whatsapp ? (
          <>
            <p className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              המספר יוצג לכל מי שפותח את הטופס: המספר שכאן, ואם הוא ריק, הטלפון שבפרטי העסק.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="מספר ל-WhatsApp"
                name="whatsapp_phone"
                type="tel"
                dir="ltr"
                inputMode="tel"
                maxLength={30}
                autoComplete="off"
                placeholder={businessPhone ?? "050-1234567"}
                defaultValue={values?.whatsapp_phone ?? intake.whatsappPhone ?? ""}
                error={errors.whatsapp_phone}
                hint={businessPhone ? "ריק: הטלפון שבפרטי העסק." : "בפרטי העסק אין טלפון, לכן צריך מספר כאן."}
              />
              <TextareaField
                label="הודעה מוכנה בשיחה (לא חובה)"
                name="whatsapp_text"
                rows={2}
                maxLength={300}
                placeholder="היי, מילאתי עכשיו את הטופס באתר"
                defaultValue={values?.whatsapp_text ?? intake.whatsappText ?? ""}
                error={errors.whatsapp_text}
              />
            </div>
          </>
        ) : null}
      </div>
      <TextField
        label="מעבר לדף אחרי שליחה (לא חובה)"
        name="redirect_url"
        dir="ltr"
        inputMode="url"
        autoComplete="off"
        placeholder="https://example.co.il/thanks"
        defaultValue={values?.redirect_url ?? intake.redirectUrl ?? ""}
        error={errors.redirect_url}
        hint="כשיש כתובת, עוברים אליה במקום הודעת התודה וכפתור ה-WhatsApp."
      />
    </fieldset>
  );
}

/** A read-only snippet with a copy button. */
export function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        readOnly
        dir="ltr"
        rows={Math.min(8, value.split("\n").length + 1)}
        className="font-mono text-sm"
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "הועתק" : "העתקה"}
        <span className="sr-only">: {label}</span>
      </Button>
    </div>
  );
}

/**
 * The form's public link, first on the sharing screen (FXU-11): most businesses
 * share it in WhatsApp, a post or an ad, and have no website to embed it in.
 */
export function ShareLink({ url, title }: { url: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>קישור לשיתוף</Label>
      <Input id={id} value={url} readOnly dir="ltr" className="font-mono text-sm" onFocus={(event) => event.currentTarget.select()} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {
              // clipboard blocked: the link is selectable in the field
              setCopied(false);
            }
          }}
        >
          {copied ? "הקישור הועתק" : "העתקת הקישור"}
        </Button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(`${title}\n${url}`)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClasses("secondary", "sm")}
        >
          שליחה ב-WhatsApp
          <span className="sr-only"> (נפתח בחלון חדש)</span>
        </a>
        <a href={url} target="_blank" rel="noopener" className={buttonClasses("secondary", "sm")}>
          פתיחת הטופס
          <span className="sr-only"> (נפתח בחלון חדש)</span>
        </a>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? "הקישור הועתק" : ""}
      </span>
    </div>
  );
}
