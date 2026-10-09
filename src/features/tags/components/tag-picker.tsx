"use client";

import { useActionState, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveRecordTagsAction } from "../actions";
import type { TagOption } from "../queries";
import { tagTone } from "../types";
import type { Taggable } from "../types";

type Props = { orgId: string; kind: Taggable; recordId: string; allTags: TagOption[]; selectedIds: string[]; canEdit: boolean };

/** The tags of a record, with an in-place editor. */
export function TagPicker({ orgId, kind, recordId, allTags, selectedIds, canEdit }: Props) {
  const [editing, setEditing] = useState(false);
  const selected = allTags.filter((tag) => selectedIds.includes(tag.id));

  return (
    <Card aria-labelledby={`tags-${recordId}`}>
      <CardHeader
        id={`tags-${recordId}`}
        title="תגיות"
        action={
          canEdit && !editing ? (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              עריכת תגיות
            </Button>
          ) : null
        }
      />
      <CardBody>
        {editing ? (
          <TagForm orgId={orgId} kind={kind} recordId={recordId} allTags={allTags} selectedIds={selectedIds} onDone={() => setEditing(false)} />
        ) : selected.length === 0 ? (
          <p className="text-md text-ink-soft">אין תגיות.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {selected.map((tag) => (
              <li key={tag.id}>
                <Badge tone={tagTone(tag.color)}>{tag.name}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

type FormProps = Omit<Props, "canEdit"> & { onDone: () => void };

function TagForm({ orgId, kind, recordId, allTags, selectedIds, onDone }: FormProps) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveRecordTagsAction(orgId, kind, recordId, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {/* what the record had when the picker opened: the save adds and removes against it (FXD-04) */}
      {selectedIds.map((id) => (
        <input key={id} type="hidden" name="shown_tag_id" value={id} />
      ))}
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      {allTags.length > 0 ? (
        <fieldset>
          <legend className="sr-only">תגיות קיימות</legend>
          <div className="flex flex-wrap gap-2">
            {allTags.map((tag) => (
              <label
                key={tag.id}
                className="flex min-h-9 cursor-pointer items-center gap-2 rounded-full border border-line px-3 text-sm has-checked:border-accent has-checked:bg-accent-soft"
              >
                <input type="checkbox" name="tag_id" value={tag.id} defaultChecked={selectedIds.includes(tag.id)} className="size-4 accent-accent" />
                {tag.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <TextField
        label="תגית חדשה"
        name="new_tag"
        maxLength={40}
        autoComplete="off"
        placeholder="למשל: לקוח VIP"
        controlSize="sm"
        defaultValue={failure?.values?.new_tag}
        error={failure?.fieldErrors?.name}
      />
      <div className="flex gap-2">
        <SubmitButton size="sm">שמירה</SubmitButton>
        <Button variant="ghost" size="sm" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
