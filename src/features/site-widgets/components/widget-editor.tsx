"use client";

import { useActionState, useState } from "react";

import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveWidgetAction } from "../actions";
import type { SiteWidget } from "../queries";

type Option = { id: string; name: string };

/** SPD-07: a site widget's settings: what the button says and offers, where it sits, and who gets its leads. */
export function WidgetEditor({ orgId, widget, members, teams }: { orgId: string; widget: SiteWidget | null; members: Option[]; teams: Option[] }) {
  const [state, formAction] = useActionState<FormState, FormData>(saveWidgetAction.bind(null, orgId, widget?.id ?? null), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const [mode, setMode] = useState(values?.assign_mode ?? widget?.assignMode ?? "round_robin");
  const checked = (name: string, current: boolean | undefined, fallback: boolean) => (values ? values[name] === "on" : (current ?? fallback));

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="שם (רק בשבילכם)" name="name" maxLength={80} required defaultValue={values?.name ?? widget?.name ?? ""} error={errors.name} hint="למשל: האתר הראשי, דף הנחיתה של הקיץ." />
        <TextField label="מה כתוב על הכפתור" name="button_label" maxLength={40} required defaultValue={values?.button_label ?? widget?.buttonLabel ?? "דברו איתנו"} error={errors.button_label} />
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-md font-medium">מה מופיע בלחיצה</legend>
        <Checkbox name="show_whatsapp" label="WhatsApp" defaultChecked={checked("show_whatsapp", widget?.showWhatsapp, true)} />
        <Checkbox name="show_call" label="חיוג" defaultChecked={checked("show_call", widget?.showCall, true)} />
        <Checkbox name="show_form" label="טופס קצר (שם, טלפון, אימייל והודעה)" defaultChecked={checked("show_form", widget?.showForm, true)} />
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="מספר ל-WhatsApp ולחיוג"
          name="phone"
          type="tel"
          dir="ltr"
          maxLength={40}
          defaultValue={values?.phone ?? widget?.phone ?? ""}
          error={errors.phone}
          hint="ריק: הטלפון של העסק. מספר שאי אפשר לחייג אליו לא מוצג."
        />
        <SelectField label="איפה הכפתור בדף" name="position" defaultValue={values?.position ?? widget?.position ?? "left"} error={errors.position}>
          <option value="left">בפינה השמאלית התחתונה</option>
          <option value="right">בפינה הימנית התחתונה</option>
        </SelectField>
      </div>
      <fieldset className="space-y-4 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-medium">למי הולך ליד מהטופס</legend>
        <div className="space-y-2">
          <label className="flex items-start gap-2.5 text-md">
            <input type="radio" name="assign_mode" value="round_robin" checked={mode === "round_robin"} onChange={() => setMode("round_robin")} className="mt-1 size-4 accent-accent" />
            <span>לפי חלוקת הלידים של העסק</span>
          </label>
          <label className="flex items-start gap-2.5 text-md">
            <input type="radio" name="assign_mode" value="owner" checked={mode === "owner"} onChange={() => setMode("owner")} className="mt-1 size-4 accent-accent" />
            <span>לחבר צוות קבוע</span>
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label={mode === "round_robin" ? "מי משתתף בחלוקה" : "הצוות של הליד"} name="team_id" defaultValue={values?.team_id ?? widget?.teamId ?? ""} error={errors.team_id}>
            <option value="">{mode === "round_robin" ? "כל המשתמשים בעסק" : "ללא צוות"}</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                צוות {team.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={mode === "round_robin" ? "אם אף אחד לא זמין" : "חבר הצוות"}
            name="owner_id"
            defaultValue={values?.owner_id ?? widget?.ownerId ?? ""}
            error={errors.owner_id}
            hint='בלי אחראי: ההתראה נשלחת לצוות של הליד (בלי צוות: לבעלים ולמנהלי המערכת), והראשון שלוחץ "לקחתי" מקבל אותו.'
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
      <Checkbox name="is_active" label="הכפתור פעיל" hint="כשהכפתור כבוי, הוא לא מופיע באתר (תוך כמה דקות)." defaultChecked={checked("is_active", widget?.isActive, true)} />
      <SubmitButton>{widget ? "שמירת הכפתור" : "יצירת הכפתור"}</SubmitButton>
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
    </form>
  );
}
