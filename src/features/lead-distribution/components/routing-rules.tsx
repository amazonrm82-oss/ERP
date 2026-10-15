"use client";

import { useActionState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addRuleAction, deleteRuleAction, moveRuleAction, setRuleActiveAction } from "../actions";
import { LOCALE_OPTIONS } from "@/features/contacts/preferences";

import type { ListField, NamedOption } from "../queries";
import { FIELD_SEPARATOR, ruleConditionText, ruleTargetText, TARGET_TEAM, TARGET_USER, type RoutingRule } from "../settings";

// people: who a rule may name (active members who are not viewers)
type Choices = { sources: NamedOption[]; teams: NamedOption[]; products: NamedOption[]; fields: ListField[]; people: NamedOption[] };

function names(options: NamedOption[]) {
  return new Map(options.map((option) => [option.id, option.name]));
}

/** The rules in their order: the first active rule that matches a lead decides its team (CAP-08). */
export function RoutingRuleList({ orgId, rules, choices, editable }: { orgId: string; rules: RoutingRule[]; choices: Choices; editable: boolean }) {
  const sources = names(choices.sources);
  const products = names(choices.products);
  const teams = names(choices.teams);
  const people = names(choices.people);
  const fields = new Map(choices.fields.map((field) => [field.key, field.label]));
  if (rules.length === 0) {
    return <p className="px-4 py-3 text-sm text-ink-soft sm:px-5">אין כללים. כל הלידים מחולקים בצוות של הטופס.</p>;
  }
  return (
    <ol className="divide-y divide-line">
      {rules.map((rule, index) => {
        const condition = ruleConditionText(rule, {
          source: rule.sourceId ? sources.get(rule.sourceId) : undefined,
          product: rule.productId ? products.get(rule.productId) : undefined,
          field: rule.fieldKey ? fields.get(rule.fieldKey) : undefined,
        });
        const label = `${condition} ${ruleTargetText(rule, {
          team: rule.teamId ? teams.get(rule.teamId) : undefined,
          user: rule.userId ? people.get(rule.userId) : undefined,
        })}`;
        return (
          <li key={`${rule.id}-${rule.isActive}-${rule.position}`} className="space-y-2 px-4 py-3 sm:px-5">
            <p className="min-w-0 break-words">
              <span className="me-2 text-sm text-ink-soft">{index + 1}.</span>
              {label}
              {rule.isActive ? null : (
                <span className="ms-2">
                  <Badge>כבוי</Badge>
                </span>
              )}
            </p>
            {editable ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <ActionButton action={moveRuleAction.bind(null, orgId, rule.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={label} disabled={index === 0}>
                  הזזה למעלה
                </ActionButton>
                <ActionButton action={moveRuleAction.bind(null, orgId, rule.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={label} disabled={index === rules.length - 1}>
                  הזזה למטה
                </ActionButton>
                <ActionButton action={setRuleActiveAction.bind(null, orgId, rule.id, !rule.isActive)} pendingText="מעדכנים…" variant="ghost" srLabel={label}>
                  {rule.isActive ? "כיבוי" : "הפעלה"}
                </ActionButton>
                <ActionButton action={deleteRuleAction.bind(null, orgId, rule.id)} pendingText="מוחקים…" variant="danger-ghost" srLabel={label} confirm="למחוק את הכלל? לידים שכבר חולקו לא משתנים.">
                  מחיקה
                </ActionButton>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** A new rule: a source, a product, a language and/or a list field, and a team or one person. */
export function AddRoutingRuleForm({ orgId, choices }: { orgId: string; choices: Choices }) {
  const [state, formAction] = useActionState<FormState, FormData>(addRuleAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};

  const listFields = choices.fields.filter((field) => field.active && field.options.length > 0);

  return (
    <form action={formAction} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField label="מקור הליד" name="source_id" defaultValue={failure?.values?.source_id ?? ""} error={errors.source_id}>
          <option value="">כל מקור</option>
          {choices.sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="המוצר שהליד מבקש" name="product_id" defaultValue={failure?.values?.product_id ?? ""} error={errors.product_id}>
          <option value="">כל מוצר</option>
          {choices.products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="השפה המועדפת" name="locale" defaultValue={failure?.values?.locale ?? ""} error={errors.locale}>
          <option value="">כל שפה</option>
          {LOCALE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
        {listFields.length > 0 ? (
          <SelectField
            label="ערך בשדה רשימה"
            hint="למשל אזור, עד שיהיו סניפים"
            name="field"
            defaultValue={failure?.values?.field ?? ""}
            error={errors.field}
          >
            <option value="">כל ערך</option>
            {listFields.map((field) => (
              <optgroup key={field.key} label={field.label}>
                {field.options.map((option) => (
                  <option key={option} value={`${field.key}${FIELD_SEPARATOR}${option}`}>
                    {`${field.label}: ${option}`}
                  </option>
                ))}
              </optgroup>
            ))}
          </SelectField>
        ) : null}
        <SelectField label="לאן הליד הולך" name="target" required defaultValue={failure?.values?.target ?? ""} error={errors.target}>
          <option value="" disabled>
            בחירת צוות או אדם
          </option>
          {choices.teams.length > 0 ? (
            <optgroup label="צוות (בתוכו לפי השיטה שנבחרה)">
              {choices.teams.map((team) => (
                <option key={team.id} value={`${TARGET_TEAM}${team.id}`}>
                  {team.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label="אדם אחד">
            {choices.people.map((person) => (
              <option key={person.id} value={`${TARGET_USER}${person.id}`}>
                {person.name}
              </option>
            ))}
          </optgroup>
        </SelectField>
      </div>
      {failure && !failure.fieldErrors ? <p className="text-sm text-danger">{failure.message}</p> : null}
      <SubmitButton size="sm" pendingText="מוסיפים…">
        הוספת כלל
      </SubmitButton>
    </form>
  );
}
