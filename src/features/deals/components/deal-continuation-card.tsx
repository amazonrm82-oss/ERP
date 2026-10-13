"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { formatMoney } from "@/lib/format";
import { paths } from "@/lib/paths";

import { duplicateDealAction, followUpDealAction } from "../actions";
import { copyName, DEAL_NAME_MAX, followUpName } from "../copy";
import { DEAL_STATUS } from "../display";
import type { DealLinks, PipelineOption } from "../queries";

type Props = {
  orgId: string;
  deal: { id: string; name: string; pipelineId: string; stageName: string | null; stageOpen: boolean };
  links: DealLinks;
  // null: the user cannot create deals (viewer, read-only business); the buttons are hidden
  pipelines: PipelineOption[] | null;
};

/**
 * DEAL-11 on the deal page: "duplicate" and "follow-up deal", the deal this one continues,
 * and the follow-ups that continue it. Both windows create the new deal and open it.
 */
export function DealContinuationCard({ orgId, deal, links, pipelines }: Props) {
  const [open, setOpen] = useState<"copy" | "follow" | null>(null);
  if (!pipelines && !links.previous && links.followUps.length === 0) {
    return null;
  }
  const close = () => setOpen(null);

  return (
    <Card aria-labelledby="deal-continuation-title">
      <CardHeader id="deal-continuation-title" title="שכפול והמשך" />
      <CardBody className="space-y-4">
        {links.previous ? (
          <p className="text-md">
            <span className="text-ink-soft">עסקת המשך של </span>
            <Link href={paths.deal(orgId, links.previous.id)} className="break-words font-medium text-accent-strong underline underline-offset-4">
              {links.previous.name}
            </Link>
          </p>
        ) : null}

        {links.followUps.length > 0 ? (
          <div>
            <h3 className="mb-1 text-sm font-semibold text-ink-soft">עסקאות המשך</h3>
            <ul className="divide-y divide-line">
              {links.followUps.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="min-w-0">
                    <Link href={paths.deal(orgId, item.id)} className="block break-words font-medium underline-offset-4 hover:underline">
                      {item.name}
                    </Link>
                    <span className="block text-sm text-ink-soft">
                      {formatMoney(item.amountAgorot)}
                      {item.stageName ? `, ${item.stageName}` : ""}
                    </span>
                  </span>
                  <Badge tone={DEAL_STATUS[item.status].tone}>{DEAL_STATUS[item.status].label}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {pipelines ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setOpen("copy")}>
              שכפול
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setOpen("follow")}>
              עסקת המשך
            </Button>
          </div>
        ) : null}
      </CardBody>

      {pipelines ? (
        <>
          <Dialog open={open === "copy"} onClose={close} title="שכפול עסקה" description="נוצרת עסקה חדשה ופתוחה עם אותם פרטים, ואתם הבעלים שלה." variant="sheet">
            {open === "copy" ? <DuplicateForm orgId={orgId} deal={deal} onCancel={close} /> : null}
          </Dialog>
          <Dialog open={open === "follow"} onClose={close} title="עסקת המשך" description="עסקה חדשה לאותו לקוח, בלי סכום." variant="sheet">
            {open === "follow" ? <FollowUpForm orgId={orgId} deal={deal} pipelines={pipelines} onCancel={close} /> : null}
          </Dialog>
        </>
      ) : null}
    </Card>
  );
}

function DuplicateForm({ orgId, deal, onCancel }: { orgId: string; deal: Props["deal"]; onCancel: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(duplicateDealAction.bind(null, orgId, deal.id), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <TextField
        label="שם העסקה החדשה"
        name="name"
        required
        maxLength={DEAL_NAME_MAX}
        defaultValue={failure?.values?.name ?? copyName(deal.name)}
        error={failure?.fieldErrors?.name}
        autoFocus
      />
      {deal.stageOpen && deal.stageName ? (
        <Checkbox
          name="keep_stage"
          label={`להשאיר בשלב "${deal.stageName}"`}
          hint="בלי הסימון העסקה מתחילה בשלב הפתוח הראשון."
          defaultChecked={failure?.values?.keep_stage === "on"}
        />
      ) : (
        <p className="text-sm text-ink-soft">העסקה החדשה תתחיל בשלב הפתוח הראשון.</p>
      )}
      <p className="text-sm text-ink-soft">מועתקים: סכום, איש קשר, חברה, מקור, תגיות ושדות נוספים שהערך שלהם עדיין תקין. לא מועתקים: היסטוריה, משימות, קבצים, עוקבים וסטטוס סגירה.</p>
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצרים…">יצירת עותק</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

function FollowUpForm({ orgId, deal, pipelines, onCancel }: { orgId: string; deal: Props["deal"]; pipelines: PipelineOption[]; onCancel: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(followUpDealAction.bind(null, orgId, deal.id), null);
  const failure = state && !state.ok ? state : null;
  const picked = failure?.values?.pipeline_id ?? deal.pipelineId;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <TextField
        label="שם העסקה"
        name="name"
        required
        maxLength={DEAL_NAME_MAX}
        defaultValue={failure?.values?.name ?? followUpName(deal.name)}
        error={failure?.fieldErrors?.name}
        autoFocus
      />
      {pipelines.length > 1 ? (
        <SelectField label="תהליך מכירה" name="pipeline_id" defaultValue={picked} error={failure?.fieldErrors?.pipeline_id}>
          {pipelines.map((pipeline) => (
            <option key={pipeline.id} value={pipeline.id}>
              {pipeline.name}
            </option>
          ))}
        </SelectField>
      ) : (
        <input type="hidden" name="pipeline_id" value={picked} />
      )}
      <Checkbox
        name="link"
        label="לקשר לעסקה הזו"
        hint="בעסקה החדשה יופיע שהיא המשך של העסקה הזו."
        defaultChecked={failure?.values ? failure.values.link === "on" : true}
      />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצרים…">יצירת עסקת המשך</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
