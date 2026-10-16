"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-picker";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, Select, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { TextLink } from "@/components/ui/text-link";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { createAutomationAction, updateAutomationAction } from "../actions";
import type { BuilderInitial } from "../convert";
import { DEAL_NAME_MAX, DEFAULT_DEAL_NAME, NOTE_BODY_MAX, openStagesOf } from "../create-records";
import { DATE_TRIGGER_HOUR, DATE_TRIGGER_MAX_DAYS, dateTriggerChoices } from "../date-trigger";
import { ACTION_LABELS, actionsFor, CONDITIONS, TASK_TYPES, TRIGGERS, type ActionType, type Entity } from "../definitions";
import type { Lookups } from "../queries";
import { setFieldChoices, type SetFieldChoice } from "../set-field";

type Draft = Record<string, string>;
type Condition = { key: string; value: string };

const ENTITY_GROUPS = [
  { entity: "lead", label: "לידים" },
  { entity: "contact", label: "אנשי קשר" },
  { entity: "company", label: "חברות" },
  { entity: "deal", label: "עסקאות" },
  { entity: "task", label: "משימות" },
] as const;

function blankAction(type: ActionType): Draft {
  switch (type) {
    case "create_task":
      return { type, title: "", due_amount: "0", due_unit: "none", assign: "owner", user_id: "", task_type: "todo" };
    case "notify":
      return { type, to: "owner", user_id: "", title: "" };
    case "assign_owner":
      return { type, mode: "round_robin", user_id: "", team_id: "" };
    case "add_tag":
      return { type, tag_id: "" };
    case "set_lead_status":
      return { type, status_id: "", reason_id: "" };
    case "move_deal_stage":
      return { type, stage_id: "" };
    case "set_field":
      return { type, field: "", value: "" };
    case "create_deal":
      return { type, name: "", pipeline_id: "", stage_id: "", amount: "", assign: "owner", user_id: "" };
    case "create_note":
      return { type, body: "" };
  }
}

/** Drops empty optional ids so the server schema sees "not chosen" rather than "". */
function clean(draft: Draft): Record<string, string> {
  return Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== ""));
}

type Props = {
  orgId: string;
  lookups: Lookups;
  // editing an existing rule: its id and saved values (its record type cannot change)
  edit?: { id: string; initial: BuilderInitial };
};

/** "When … if … then …" form for a new automation, or to edit one. */
export function RuleBuilder({ orgId, lookups, edit }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(
    edit ? updateAutomationAction.bind(null, orgId, edit.id) : createAutomationAction.bind(null, orgId),
    null,
  );
  const failure = state && !state.ok ? state : null;
  const initial = edit?.initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [triggerKey, setTriggerKey] = useState(initial?.trigger ?? TRIGGERS[0].key);
  const [triggerTo, setTriggerTo] = useState(initial?.triggerTo ?? "");
  const [triggerNumber, setTriggerNumber] = useState(initial?.triggerNumber ?? "");
  // AUT-03: a date trigger
  const [dateField, setDateField] = useState(initial?.triggerField ?? "");
  const [dateDirection, setDateDirection] = useState(initial?.triggerDirection ?? "before");
  const [dateDays, setDateDays] = useState(initial?.triggerDays ?? "1");
  const [conditions, setConditions] = useState<Condition[]>(initial?.conditions ?? []);
  const [actions, setActions] = useState<Draft[]>(
    initial?.actions.length ? initial.actions.map((a) => ({ ...blankAction(a.type as ActionType), ...a })) : [blankAction("create_task")],
  );
  // an existing rule keeps its record type
  const fixedEntity = initial ? TRIGGERS.find((t) => t.key === initial.trigger)?.entity : undefined;

  const trigger = TRIGGERS.find((t) => t.key === triggerKey)!;
  const entity = trigger.entity;
  const conditionOptions = CONDITIONS.filter((c) => c.entities.includes(entity));
  const actionOptions = actionsFor(entity);
  const stages = lookups.pipelines.flatMap((p) => p.stages.map((s) => ({ id: s.id, name: `${p.name}: ${s.name}` })));

  function changeTrigger(key: string) {
    const next = TRIGGERS.find((t) => t.key === key)!;
    setTriggerKey(key);
    setTriggerTo("");
    setTriggerNumber(next.number ? String(next.number.default) : "");
    // a date field of another record type is picked again
    if (next.entity !== entity) setDateField("");
    // drop what does not fit the new record type
    setConditions((list) => list.filter((c) => CONDITIONS.find((o) => o.key === c.key)?.entities.includes(next.entity)));
    setActions((list) => {
      const kept = list
        .filter((a) => actionsFor(next.entity).includes(a.type as ActionType))
        // AUT-01: a field of another record type is picked again
        .map((a) => (a.type === "set_field" && next.entity !== entity ? blankAction("set_field") : a));
      return kept.length > 0 ? kept : [blankAction("create_task")];
    });
  }

  const updateAction = (index: number, patch: Draft) =>
    setActions((list) => list.map((action, i) => (i === index ? { ...action, ...patch } : action)));

  const payload = JSON.stringify({
    name,
    trigger: triggerKey,
    ...(triggerTo ? { trigger_to: triggerTo } : {}),
    ...(trigger.number && triggerNumber ? { trigger_number: triggerNumber } : {}),
    ...(trigger.date
      ? { trigger_field: dateField, trigger_direction: dateDirection, ...(dateDirection === "on" ? {} : { trigger_days: dateDays }) }
      : {}),
    conditions: conditions.map((c) => (c.value ? c : { key: c.key })),
    actions: actions.map(clean),
  });

  const valueInput = (condition: Condition, index: number) => {
    const option = CONDITIONS.find((c) => c.key === condition.key)!;
    const set = (value: string) => setConditions((list) => list.map((c, i) => (i === index ? { ...c, value } : c)));
    const label = `ערך לתנאי ${index + 1}`;
    const list =
      option.input === "source"
        ? lookups.sources
        : option.input === "status"
          ? lookups.statuses
          : option.input === "tag"
            ? lookups.tags
            : option.input === "pipeline"
              ? lookups.pipelines
              : option.input === "task_type"
                ? TASK_TYPES.map((t) => ({ id: t.value, name: t.label }))
                : null;
    if (option.input === "none") return null;
    if (option.input === "shekels") {
      return <TextField label={label} hideLabel value={condition.value} onChange={(e) => set(e.target.value)} dir="ltr" inputMode="decimal" controlSize="sm" placeholder="10,000" />;
    }
    return (
      <SelectField label={label} hideLabel value={condition.value} onChange={(e) => set(e.target.value)} controlSize="sm">
        <option value="">בחירה</option>
        {list!.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </SelectField>
    );
  };

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="rule" value={payload} />
      <FormError message={failure?.message} />

      <TextField label="שם האוטומציה" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="למשל: ליד מפייסבוק לצוות מכירות" />

      <Card aria-labelledby="when-title">
        <CardHeader id="when-title" title="כאשר" />
        <CardBody className="space-y-4">
          <SelectField label="מה קורה" value={triggerKey} onChange={(e) => changeTrigger(e.target.value)}>
            {ENTITY_GROUPS.filter((group) => !fixedEntity || group.entity === fixedEntity).map((group) => (
              <optgroup key={group.entity} label={group.label}>
                {TRIGGERS.filter((t) => t.entity === group.entity).map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </SelectField>
          {trigger.field ? (
            <SelectField label={trigger.field === "status_id" ? "לסטטוס" : "לשלב"} value={triggerTo} onChange={(e) => setTriggerTo(e.target.value)}>
              <option value="">כל שינוי</option>
              {(trigger.field === "status_id" ? lookups.statuses : stages).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </SelectField>
          ) : null}
          {trigger.number ? (
            <TextField label={trigger.number.label} value={triggerNumber} onChange={(e) => setTriggerNumber(e.target.value)} dir="ltr" inputMode="numeric" className="max-w-40" />
          ) : null}
          {trigger.date ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField label="שדה התאריך" value={dateField} onChange={(e) => setDateField(e.target.value)}>
                <option value="">בחירת שדה</option>
                {dateTriggerChoices(entity, lookups).map((choice) => (
                  <option key={choice.key} value={choice.key}>
                    {choice.label}
                  </option>
                ))}
              </SelectField>
              <SelectField label="מתי" value={dateDirection} onChange={(e) => setDateDirection(e.target.value)}>
                <option value="before">לפני התאריך</option>
                <option value="on">ביום התאריך</option>
                <option value="after">אחרי התאריך</option>
              </SelectField>
              {dateDirection !== "on" ? (
                <TextField
                  label={`כמה ימים (עד ${DATE_TRIGGER_MAX_DAYS})`}
                  value={dateDays}
                  onChange={(e) => setDateDays(e.target.value)}
                  dir="ltr"
                  inputMode="numeric"
                />
              ) : null}
              <p className="text-sm text-ink-soft sm:col-span-3">
                האוטומציה רצה ביום הזה החל מ-{String(DATE_TRIGGER_HOUR).padStart(2, "0")}:00 לפי שעון העסק, פעם אחת לכל רשומה ותאריך. אם התאריך משתנה, היא תרוץ שוב לפי התאריך החדש.
              </p>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card aria-labelledby="if-title">
        <CardHeader id="if-title" title="אם (לא חובה)" />
        <CardBody className="space-y-3">
          {conditions.length === 0 ? <p className="text-md text-ink-soft">בלי תנאים: האוטומציה רצה בכל פעם.</p> : null}
          {conditions.map((condition, index) => (
            <div key={index} className="flex flex-wrap items-start gap-2">
              <div className="w-full sm:w-52">
                <Select
                  aria-label={`תנאי ${index + 1}`}
                  controlSize="sm"
                  value={condition.key}
                  onChange={(e) => setConditions((list) => list.map((c, i) => (i === index ? { key: e.target.value, value: "" } : c)))}
                >
                  {conditionOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="min-w-40 flex-1">{valueInput(condition, index)}</div>
              <Button variant="ghost" size="sm" onClick={() => setConditions((list) => list.filter((_, i) => i !== index))}>
                הסרה<span className="sr-only"> של תנאי {index + 1}</span>
              </Button>
            </div>
          ))}
          {conditions.length < 5 && conditionOptions.length > 0 ? (
            <Button variant="secondary" size="sm" onClick={() => setConditions((list) => [...list, { key: conditionOptions[0].key, value: "" }])}>
              הוספת תנאי
            </Button>
          ) : null}
        </CardBody>
      </Card>

      <Card aria-labelledby="then-title">
        <CardHeader id="then-title" title="אז" />
        <CardBody className="space-y-4">
          {actions.map((action, index) => (
            <fieldset key={index} className="space-y-3 rounded-md border border-line p-3">
              <legend className="px-1 text-sm font-medium">פעולה {index + 1}</legend>
              <div className="flex flex-wrap items-start gap-2">
                <div className="w-full sm:w-56">
                  <Select
                    aria-label={`סוג פעולה ${index + 1}`}
                    controlSize="sm"
                    value={action.type}
                    onChange={(e) => setActions((list) => list.map((a, i) => (i === index ? blankAction(e.target.value as ActionType) : a)))}
                  >
                    {actionOptions.map((type) => (
                      <option key={type} value={type}>
                        {ACTION_LABELS[type]}
                      </option>
                    ))}
                  </Select>
                </div>
                {actions.length > 1 ? (
                  <Button variant="ghost" size="sm" onClick={() => setActions((list) => list.filter((_, i) => i !== index))}>
                    הסרה<span className="sr-only"> של פעולה {index + 1}</span>
                  </Button>
                ) : null}
              </div>
              <ActionFields orgId={orgId} entity={entity} action={action} index={index} lookups={lookups} onChange={(patch) => updateAction(index, patch)} />
            </fieldset>
          ))}
          {actions.length < 10 ? (
            <Button variant="secondary" size="sm" onClick={() => setActions((list) => [...list, blankAction(actionOptions[0])])}>
              הוספת פעולה
            </Button>
          ) : null}
          <p className="text-sm text-ink-soft">בכותרות, בשם העסקה ובהערה אפשר לכתוב {"{{name}}"} במקום שם הרשומה.</p>
        </CardBody>
      </Card>

      <SubmitButton pendingText="שומרים…">{edit ? "שמירת השינויים" : "שמירה והפעלה"}</SubmitButton>
    </form>
  );
}

type FieldsProps = { orgId: string; entity: Entity; action: Draft; index: number; lookups: Lookups; onChange: (patch: Draft) => void };

function ActionFields({ orgId, entity, action, index, lookups, onChange }: FieldsProps) {
  const n = index + 1;
  const memberSelect = (label: string) => (
    <SelectField label={label} value={action.user_id} onChange={(e) => onChange({ user_id: e.target.value })} controlSize="sm">
      <option value="">בחירת משתמש</option>
      {lookups.members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </SelectField>
  );
  const pick = (label: string, key: string, list: Array<{ id: string; name: string }>) => (
    <SelectField label={label} value={action[key]} onChange={(e) => onChange({ [key]: e.target.value })} controlSize="sm">
      <option value="">בחירה</option>
      {list.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
    </SelectField>
  );

  switch (action.type) {
    case "create_task":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={`כותרת המשימה (פעולה ${n})`} value={action.title} onChange={(e) => onChange({ title: e.target.value })} maxLength={300} className="sm:col-span-2" controlSize="sm" />
          <SelectField label="מועד" value={action.due_unit} onChange={(e) => onChange({ due_unit: e.target.value })} controlSize="sm">
            <option value="none">בלי מועד</option>
            <option value="minutes">בעוד X דקות</option>
            <option value="days">בעוד X ימים</option>
            <option value="business_days">בעוד X ימי עסקים</option>
          </SelectField>
          {action.due_unit !== "none" ? (
            <TextField label={action.due_unit === "minutes" ? "דקות" : action.due_unit === "business_days" ? "ימי עסקים (עד 60)" : "ימים"} value={action.due_amount} onChange={(e) => onChange({ due_amount: e.target.value })} dir="ltr" inputMode="numeric" controlSize="sm" />
          ) : null}
          <SelectField label="סוג" value={action.task_type} onChange={(e) => onChange({ task_type: e.target.value })} controlSize="sm">
            {TASK_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </SelectField>
          <SelectField label="באחריות" value={action.assign} onChange={(e) => onChange({ assign: e.target.value })} controlSize="sm">
            <option value="owner">האחראי על הרשומה</option>
            <option value="user">משתמש מסוים</option>
          </SelectField>
          {action.assign === "user" ? memberSelect("משתמש") : null}
        </div>
      );
    case "notify":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={`נוסח ההתראה (פעולה ${n})`} value={action.title} onChange={(e) => onChange({ title: e.target.value })} maxLength={200} className="sm:col-span-2" controlSize="sm" />
          <SelectField label="למי" value={action.to} onChange={(e) => onChange({ to: e.target.value })} controlSize="sm">
            <option value="owner">האחראי על הרשומה</option>
            <option value="admins">מנהלי המערכת</option>
            <option value="user">משתמש מסוים</option>
          </SelectField>
          {action.to === "user" ? memberSelect("משתמש") : null}
        </div>
      );
    case "assign_owner":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="איך" value={action.mode} onChange={(e) => onChange({ mode: e.target.value })} controlSize="sm">
            <option value="round_robin">בסבב בין הזמינים</option>
            <option value="user">למשתמש מסוים</option>
          </SelectField>
          {action.mode === "user" ? memberSelect("משתמש") : pick("מי בסבב (ריק: כל העסק)", "team_id", lookups.teams)}
        </div>
      );
    case "add_tag":
      return pick("תגית", "tag_id", lookups.tags);
    case "set_lead_status": {
      // RVW-9: moving a lead to "not relevant" needs a reason from the organization's list;
      // while the list is empty the rule saves without one (owner, 13 October 2026)
      const disqualified = lookups.statuses.find((s) => s.id === action.status_id)?.kind === "disqualified";
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {pick("סטטוס", "status_id", lookups.statuses.filter((s) => s.kind !== "converted"))}
          {disqualified ? (
            lookups.reasons.length > 0 ? (
              <SelectField label="סיבה" value={action.reason_id ?? ""} onChange={(e) => onChange({ reason_id: e.target.value })} controlSize="sm" required>
                <option value="">בחירת סיבה</option>
                {lookups.reasons.map((reason) => (
                  <option key={reason.id} value={reason.id}>
                    {reason.name}
                  </option>
                ))}
              </SelectField>
            ) : (
              <p className="text-sm text-ink-soft sm:self-end">
                אין סיבות מוגדרות בעסק.{" "}
                <TextLink href={paths.settingsDisqualifyReasons(orgId)} target="_blank" className="font-medium">
                  להוספת סיבות
                  <span className="sr-only"> (נפתח בלשונית חדשה)</span>
                </TextLink>{" "}
                אחרי שמוסיפים, מרעננים את הדף ובוחרים סיבה.
              </p>
            )
          ) : null}
        </div>
      );
    }
    case "move_deal_stage":
      return pick(
        "שלב",
        "stage_id",
        lookups.pipelines.flatMap((p) => p.stages.map((s) => ({ id: s.id, name: `${p.name}: ${s.name}` }))),
      );
    case "create_deal": {
      // AUT-02: the deal is linked to the record's customer (the engine decides which); open stages only
      const stages = action.pipeline_id ? openStagesOf(lookups.pipelines, action.pipeline_id) : [];
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={`שם העסקה (פעולה ${n})`}
            value={action.name}
            onChange={(e) => onChange({ name: e.target.value })}
            maxLength={DEAL_NAME_MAX}
            placeholder={DEFAULT_DEAL_NAME}
            hint={`ריק: "${DEFAULT_DEAL_NAME}"`}
            className="sm:col-span-2"
            controlSize="sm"
          />
          <SelectField label="תהליך מכירה" value={action.pipeline_id} onChange={(e) => onChange({ pipeline_id: e.target.value, stage_id: "" })} controlSize="sm">
            <option value="">בחירה</option>
            {lookups.pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
          <SelectField label="שלב" value={action.stage_id} onChange={(e) => onChange({ stage_id: e.target.value })} controlSize="sm" disabled={!action.pipeline_id}>
            <option value="">השלב הפתוח הראשון</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
          <TextField label="שווי (₪, לא חובה)" value={action.amount} onChange={(e) => onChange({ amount: e.target.value })} dir="ltr" inputMode="decimal" controlSize="sm" placeholder="10,000" />
          <SelectField label="באחריות" value={action.assign} onChange={(e) => onChange({ assign: e.target.value })} controlSize="sm">
            <option value="owner">האחראי על הרשומה</option>
            <option value="user">משתמש מסוים</option>
          </SelectField>
          {action.assign === "user" ? memberSelect("משתמש") : null}
          <p className="text-sm text-ink-soft sm:col-span-2">
            העסקה מקושרת ללקוח של הרשומה: איש הקשר והחברה שלו, החברה, או איש הקשר והחברה של העסקה או המשימה.
            {entity === "deal" ? " עסקה שנוצרת מעסקה נרשמת כהמשך שלה." : ""}
          </p>
        </div>
      );
    }
    case "create_note":
      return (
        <TextareaField
          label={`נוסח ההערה (פעולה ${n})`}
          value={action.body}
          onChange={(e) => onChange({ body: e.target.value })}
          maxLength={NOTE_BODY_MAX}
          rows={3}
          hint={entity === "task" ? "ההערה נכתבת על הרשומות שהמשימה מקושרת אליהן, ומסומנת כהערה מאוטומציה." : "ההערה מסומנת כהערה מאוטומציה, ואינה נחשבת פעילות או קשר עם הלקוח."}
        />
      );
    case "set_field": {
      const choices = setFieldChoices(entity, lookups);
      const choice = choices.find((item) => item.key === action.field);
      if (choices.length === 0) {
        return <p className="text-sm text-ink-soft">לסוג הרשומה הזה עוד אין שדות שאפשר לעדכן. אפשר להוסיף שדות מותאמים בהגדרות.</p>;
      }
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label={`שדה (פעולה ${n})`} value={action.field} onChange={(e) => onChange({ field: e.target.value, value: "" })} controlSize="sm">
            <option value="">בחירת שדה</option>
            {choices.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </SelectField>
          {choice ? <SetFieldValue key={choice.key} choice={choice} value={action.value ?? ""} n={n} lookups={lookups} onChange={(value) => onChange({ value })} /> : null}
        </div>
      );
    }
    default:
      return null;
  }
}

const CLEAR = "ריקון השדה";

/** AUT-01: the value a set_field step writes, in the field's own kind of input. Empty clears the field. */
function SetFieldValue({
  choice,
  value,
  n,
  lookups,
  onChange,
}: {
  choice: SetFieldChoice;
  value: string;
  n: number;
  lookups: Lookups;
  onChange: (value: string) => void;
}) {
  const label = `הערך החדש (פעולה ${n})`;
  const list = (items: Array<{ value: string; label: string }>, clearable = true) => (
    <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value)} controlSize="sm">
      {clearable ? <option value="">{CLEAR}</option> : <option value="">בחירה</option>}
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </SelectField>
  );
  if (choice.key === "source_id") return list(lookups.sources.map((s) => ({ value: s.id, label: s.name })));
  if (choice.key === "task_type") return list(TASK_TYPES.map((t) => ({ value: t.value, label: t.label })), false);
  const field = choice.definition;
  if (!field) return null;
  const text = (props: { dir?: "ltr"; inputMode?: "decimal" | "numeric" | "tel" | "email" | "url"; type?: string; hint?: string }) => (
    <TextField
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      controlSize="sm"
      maxLength={2000}
      hint={props.hint ?? "ריק: השדה יתרוקן."}
      dir={props.dir}
      inputMode={props.inputMode}
      type={props.type}
    />
  );
  switch (field.type) {
    case "select":
    case "status":
      return list(field.options.map((option) => ({ value: option, label: option })));
    case "rating":
      return list(["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: `${v} מתוך 5` })));
    case "user":
      return list((field.choices ?? lookups.members.map((m) => ({ value: m.id, label: m.name }))).map((c) => ({ value: c.value, label: c.label })));
    case "checkbox":
      return (
        <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value)} controlSize="sm">
          <option value="true">כן</option>
          <option value="">לא</option>
        </SelectField>
      );
    case "multi_select": {
      const picked = value.split("\n").filter(Boolean);
      return (
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-sm font-medium">{label}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {field.options.map((option) => (
              <Checkbox
                key={option}
                label={option}
                checked={picked.includes(option)}
                onChange={(e) => onChange(field.options.filter((o) => (o === option ? e.target.checked : picked.includes(o))).join("\n"))}
              />
            ))}
          </div>
          <p className="mt-1 text-sm text-ink-soft">בלי בחירה: השדה יתרוקן.</p>
        </fieldset>
      );
    }
    case "date":
      return <DateField label={label} value={value} onChange={onChange} hint="בלי תאריך: השדה יתרוקן." />;
    case "datetime":
      return text({ type: "datetime-local", dir: "ltr" });
    case "number":
    case "percent":
      return text({ dir: "ltr", inputMode: "decimal" });
    case "currency":
      return text({ dir: "ltr", inputMode: "decimal", hint: "בשקלים. ריק: השדה יתרוקן." });
    case "phone":
      return text({ dir: "ltr", inputMode: "tel" });
    case "email":
      return text({ dir: "ltr", inputMode: "email" });
    case "url":
      return text({ dir: "ltr", inputMode: "url" });
    case "il_id":
    case "il_company_id":
      return text({ dir: "ltr", inputMode: "numeric" });
    // FLD-06: minutes or hours:minutes, as the record form takes it
    case "duration":
      return text({ dir: "ltr", inputMode: "numeric", hint: "בדקות (90) או בשעות ודקות (1:30). ריק: השדה יתרוקן." });
    // FLD-06: Markdown marks typed here work as in a note (bold, lists, links)
    case "rich_text":
    case "long_text":
    case "text":
      return text({});
    default: {
      // every type has its own input: a new type fails the build here until it gets one
      const unhandled: never = field.type;
      return unhandled;
    }
  }
}
