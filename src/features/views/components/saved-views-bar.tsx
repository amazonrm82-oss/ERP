"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { ActionButton } from "@/components/action-button";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { cn } from "@/lib/cn";
import { submitWith } from "@/lib/use-submit";

import type { ColumnChoice } from "@/features/list-columns/columns";

import { deleteViewAction, saveViewAction } from "../actions";
import type { ShareTeam } from "../queries";
import { VIEW_FILTER_KEYS, viewHref, type ViewConfig, type ViewFilters, type ViewObject } from "../types";

// shared: who else sees it ("לכולם", "צוות מכירות"), or null for a private view
export type ViewChip = { id: string; name: string; shared: string | null; deletable: boolean; config: ViewConfig };

type Props = {
  orgId: string;
  objectType: ViewObject;
  listPath: string;
  views: ViewChip[];
  // the view in use (`sv` in the URL), and what the list shows now: saving keeps all three
  activeViewId: string | null;
  current: ViewFilters;
  currentSort: string;
  currentColumns: ColumnChoice[];
  // teams a new view can be shared with
  teams: ShareTeam[];
  canSave: boolean;
  canShare: boolean;
};

/** Saved views of a list (filters, sort and columns, LST-04), as links, plus "save the current view". */
export function SavedViewsBar({ orgId, objectType, listPath, views, activeViewId, current, currentSort, currentColumns, teams, canSave, canShare }: Props) {
  const [saving, setSaving] = useState(false);

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {views.length > 0 ? <span className="text-sm text-ink-soft">תצוגות שמורות:</span> : null}
        {views.map((view) => {
          const active = view.id === activeViewId;
          return (
            <span key={view.id} className="inline-flex items-center gap-1">
              <Link
                href={viewHref(listPath, view.id, view.config)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm",
                  active ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line bg-surface hover:bg-canvas",
                )}
              >
                {view.name}
                {view.shared ? <span className="ms-1.5 text-xs text-ink-soft">({view.shared})</span> : null}
              </Link>
              {view.deletable ? (
                <ActionButton
                  action={deleteViewAction.bind(null, orgId, objectType, view.id)}
                  pendingText="…"
                  variant="ghost"
                  confirm={`למחוק את התצוגה "${view.name}"?`}
                  srLabel={view.name}
                >
                  <span aria-hidden="true">×</span>
                  <span className="sr-only">מחיקת תצוגה</span>
                </ActionButton>
              ) : null}
            </span>
          );
        })}
        {canSave && !saving ? (
          <Button variant="ghost" size="sm" onClick={() => setSaving(true)}>
            שמירת התצוגה
          </Button>
        ) : null}
      </div>
      {saving ? (
        <SaveViewForm
          orgId={orgId}
          objectType={objectType}
          current={current}
          currentSort={currentSort}
          currentColumns={currentColumns}
          teams={teams}
          canShare={canShare}
          onDone={() => setSaving(false)}
        />
      ) : null}
    </div>
  );
}

type FormProps = {
  orgId: string;
  objectType: ViewObject;
  current: ViewFilters;
  currentSort: string;
  currentColumns: ColumnChoice[];
  teams: ShareTeam[];
  canShare: boolean;
  onDone: () => void;
};

function SaveViewForm({ orgId, objectType, current, currentSort, currentColumns, teams, canShare, onDone }: FormProps) {
  const [scope, setScope] = useState("private");
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveViewAction(orgId, objectType, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;

  return (
    // submitted by hand: the "for whom" select is controlled (see submitWith)
    <form onSubmit={submitWith(formAction)} className="flex flex-wrap items-start gap-2 rounded-md border border-line bg-surface p-3" noValidate>
      {VIEW_FILTER_KEYS.map((key) => (current[key] ? <input key={key} type="hidden" name={key} value={current[key]} /> : null))}
      <input type="hidden" name="sort" value={currentSort} />
      <input type="hidden" name="columns" value={JSON.stringify(currentColumns)} />
      <TextField
        label="שם התצוגה"
        name="name"
        required
        maxLength={80}
        autoComplete="off"
        controlSize="sm"
        className="min-w-0 flex-[1_1_12rem]"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name}
      />
      {canShare || teams.length > 0 ? (
        <SelectField label="למי" name="scope" controlSize="sm" value={scope} onChange={(e) => setScope(e.target.value)} className="flex-[0_1_10rem]">
          <option value="private">רק לי</option>
          {teams.length > 0 ? <option value="team">לצוות</option> : null}
          {canShare ? <option value="org">לכל העסק</option> : null}
        </SelectField>
      ) : (
        <input type="hidden" name="scope" value="private" />
      )}
      {scope === "team" ? (
        <SelectField label="איזה צוות" name="team_id" controlSize="sm" error={failure?.fieldErrors?.team_id} className="flex-[0_1_10rem]">
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      <div className="flex gap-2 pt-6.5">
        <SubmitButton size="sm" pending={pending}>
          שמירה
        </SubmitButton>
        <Button variant="ghost" size="sm" onClick={onDone}>
          ביטול
        </Button>
      </div>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} className="basis-full" />
    </form>
  );
}
