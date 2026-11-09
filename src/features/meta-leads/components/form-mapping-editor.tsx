"use client";

import { useActionState, useState } from "react";

import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveFormMappingAction } from "../actions";
import type { MetaFormMapping } from "../queries";

type Option = { id: string; name: string };

/**
 * CAP-11: where the leads of one Meta lead form go: a fixed person, or the business's lead distribution (with a team).
 * The page's default row (no form id) takes every form that has no row of its own.
 */
export function FormMappingEditor({
  orgId,
  integrationId,
  mapping,
  members,
  teams,
}: {
  orgId: string;
  integrationId: string;
  mapping: MetaFormMapping | null;
  members: Option[];
  teams: Option[];
}) {
  const [state, formAction] = useActionState<FormState, FormData>(saveFormMappingAction.bind(null, orgId, integrationId, mapping?.id ?? null), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const [mode, setMode] = useState(values?.assign_mode ?? mapping?.assignMode ?? "round_robin");
  const isDefault = mapping !== null && mapping.metaFormId === null;
  const radio = `assign-${mapping?.id ?? "new"}`;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="שם הטופס (רק בשבילכם)" name="name" maxLength={120} required defaultValue={values?.name ?? mapping?.name ?? ""} error={errors.name} />
        {mapping === null ? (
          <TextField
            label="מזהה הטופס ב-Meta"
            name="meta_form_id"
            inputMode="numeric"
            dir="ltr"
            maxLength={40}
            required
            defaultValue={values?.meta_form_id ?? ""}
            error={errors.meta_form_id}
            hint="מופיע בספריית הטפסים של הדף, ב-Meta Business Suite."
          />
        ) : isDefault ? (
          <p className="self-end text-sm text-ink-soft">כל טופס של הדף שאין לו הגדרה משלו.</p>
        ) : (
          <p className="self-end text-sm text-ink-soft">
            מזהה הטופס: <span dir="ltr">{mapping.metaFormId}</span>
          </p>
        )}
      </div>
      <fieldset className="space-y-4 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-medium">למי הולך ליד מהטופס</legend>
        <div className="space-y-2">
          <label className="flex items-start gap-2.5 text-md">
            <input type="radio" name="assign_mode" value="round_robin" checked={mode === "round_robin"} onChange={() => setMode("round_robin")} className="mt-1 size-4 accent-accent" />
            <span>לפי חלוקת הלידים של העסק</span>
          </label>
          <label className="flex items-start gap-2.5 text-md" htmlFor={`${radio}-owner`}>
            <input id={`${radio}-owner`} type="radio" name="assign_mode" value="owner" checked={mode === "owner"} onChange={() => setMode("owner")} className="mt-1 size-4 accent-accent" />
            <span>לחבר צוות קבוע</span>
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label={mode === "round_robin" ? "מי משתתף בחלוקה" : "הצוות של הליד"} name="team_id" defaultValue={values?.team_id ?? mapping?.teamId ?? ""} error={errors.team_id}>
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
            defaultValue={values?.owner_id ?? mapping?.ownerId ?? ""}
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
      <Checkbox
        name="is_active"
        label="מקבלים לידים מהטופס"
        hint="כשהתיבה לא מסומנת, לידים חדשים מהטופס לא נכנסים למערכת."
        defaultChecked={values ? values.is_active === "on" : (mapping?.isActive ?? true)}
      />
      <SubmitButton>{mapping ? "שמירה" : "הוספת הטופס"}</SubmitButton>
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
    </form>
  );
}
