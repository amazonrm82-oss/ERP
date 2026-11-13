"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";

import { createPrefillFormAction, deletePrefillFormAction, updatePrefillFormAction } from "../actions";
import type { PrefillChoice, PrefillRecordType } from "../fields";
import type { PrefillFormItem } from "../queries";

type Props = {
  orgId: string;
  forms: PrefillFormItem[];
  choices: Record<PrefillRecordType, PrefillChoice[]>;
  // the record types' names in the business's words (prefillRecordLabels, read on the server; RVW-94)
  recordLabels: Record<PrefillRecordType, string>;
};

/** BIZ-05: the business's prefill form templates: each one's name, what the customer sees, and the fields it asks. */
export function PrefillFormsEditor({ orgId, forms, choices, recordLabels }: Props) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-4">
      {forms.length === 0 ? <p className="text-md text-ink-soft">עוד אין טפסים.</p> : null}
      <ul className="space-y-3">
        {forms.map((form) => (
          <li key={form.id}>
            <TemplateItem orgId={orgId} form={form} choices={choices[form.recordType]} recordLabels={recordLabels} />
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="rounded-md border border-line bg-canvas p-3">
          <TemplateForm orgId={orgId} choices={choices} recordLabels={recordLabels} onDone={() => setAdding(false)} />
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          טופס חדש
        </Button>
      )}
    </div>
  );
}

function TemplateItem({ orgId, form, choices, recordLabels }: { orgId: string; form: PrefillFormItem; choices: PrefillChoice[]; recordLabels: Record<PrefillRecordType, string> }) {
  const [editing, setEditing] = useState(false);
  const router = useRouter();
  const labels = new Map(choices.map((c) => [c.key, c.label]));
  return (
    <div className="space-y-2 rounded-md border border-line bg-canvas p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-md font-medium break-words">
          {form.name}
          <span className="ms-2 text-sm text-ink-soft">({recordLabels[form.recordType]})</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {form.draftWording ? <Badge tone="warning">נוסח טיוטה</Badge> : null}
          {form.isActive ? <Badge tone="success">פעיל</Badge> : <Badge>כבוי</Badge>}
        </div>
      </div>
      {editing ? (
        <TemplateForm orgId={orgId} form={form} choices={{ [form.recordType]: choices } as Record<PrefillRecordType, PrefillChoice[]>} recordLabels={recordLabels} onDone={() => setEditing(false)} />
      ) : (
        <>
          <p className="text-sm text-ink-soft break-words">השדות: {form.fields.map((key) => labels.get(key) ?? "שדה שאינו זמין").join(", ")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              עריכה
            </Button>
            <ConfirmButton
              size="sm"
              title="למחוק את הטופס?"
              description="קישורים שנשלחו עם הטופס הזה יפסיקו לעבוד."
              confirmLabel="מחיקה"
              action={deletePrefillFormAction.bind(null, orgId, form.id)}
              onDone={() => router.refresh()}
            >
              מחיקה
            </ConfirmButton>
          </div>
        </>
      )}
    </div>
  );
}

function TemplateForm({
  orgId,
  form,
  choices,
  recordLabels,
  onDone,
}: {
  orgId: string;
  form?: PrefillFormItem;
  choices: Record<PrefillRecordType, PrefillChoice[]>;
  recordLabels: Record<PrefillRecordType, string>;
  onDone: () => void;
}) {
  const router = useRouter();
  const legendId = useId();
  const [recordType, setRecordType] = useState<PrefillRecordType>(form?.recordType ?? "contact");
  const [picked, setPicked] = useState<string[]>(form?.fields ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = choices[recordType] ?? [];

  async function save(data: FormData) {
    setBusy(true);
    setError(null);
    const input = {
      name: String(data.get("name") ?? ""),
      title: String(data.get("title") ?? ""),
      intro: String(data.get("intro") ?? ""),
      // the order of the list below
      fields: list.map((c) => c.key).filter((key) => picked.includes(key)),
      isActive: data.get("is_active") === "on",
    };
    const result = form ? await updatePrefillFormAction(orgId, form.id, input) : await createPrefillFormAction(orgId, recordType, input);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onDone();
    router.refresh();
  }

  return (
    <form action={(data) => void save(data)} className="space-y-3">
      <TextField label="שם הטופס (לשימוש פנימי)" name="name" required maxLength={80} defaultValue={form?.name ?? ""} />
      {form ? null : (
        <SelectField
          label="סוג הרשומה"
          name="record_type"
          value={recordType}
          onChange={(event) => {
            setRecordType(event.target.value as PrefillRecordType);
            setPicked([]);
          }}
        >
          <option value="contact">{recordLabels.contact}</option>
          <option value="lead">{recordLabels.lead}</option>
        </SelectField>
      )}
      <TextField label="כותרת שהלקוח רואה" name="title" required maxLength={120} defaultValue={form?.title ?? ""} />
      <TextareaField label="פתיח (לא חובה)" name="intro" rows={2} maxLength={500} defaultValue={form?.intro ?? ""} />
      <fieldset aria-labelledby={legendId} className="space-y-1">
        <p id={legendId} className="text-sm font-medium">
          השדות בטופס (עד 20)
        </p>
        <p className="text-sm text-ink-soft">שדות שסומנו כמידע רגיש אינם מופיעים כאן. טופס בריאות יתאפשר בהמשך.</p>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {list.map((choice) => (
            <Checkbox
              key={choice.key}
              label={choice.label}
              checked={picked.includes(choice.key)}
              onChange={(event) => {
                const on = event.currentTarget.checked;
                setPicked((before) => (on ? [...before, choice.key] : before.filter((key) => key !== choice.key)));
              }}
            />
          ))}
        </div>
      </fieldset>
      <Checkbox label="פעיל" name="is_active" defaultChecked={form?.isActive ?? true} />
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy}>
          שמירה
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
