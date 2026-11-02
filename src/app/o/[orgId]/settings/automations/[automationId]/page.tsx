import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { BackIcon } from "@/components/ui/icons";
import { deleteAutomationAction, setAutomationActiveAction } from "@/features/automations/actions";
import { DormantActivationDialog } from "@/features/automations/components/dormant-activation-dialog";
import { TestRunForm } from "@/features/automations/components/test-run-form";
import { DORMANT_ASK_PARAM, DORMANT_TRIGGER, shouldAskDormant } from "@/features/automations/dormant-activation";
import { ACTION_LABELS, type ActionType } from "@/features/automations/definitions";
import { actionsMissingReason } from "@/features/automations/convert";
import { describeRule, quotaSkipLabel, retryLine, STEP_ERRORS, stepWarningTexts } from "@/features/automations/describe";
import { getAutomation, getDormantCount, getLookups, listRuns, listTestRecords } from "@/features/automations/queries";
import { canManageAutomations } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { ruleAuthorshipLine } from "@/features/automations/authorship";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { formatDate, formatDateTime, zoneDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "אוטומציה" };

type Props = {
  params: Promise<{ orgId: string; automationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const RUN_STATUS = {
  success: { label: "הצליחה", tone: "success" },
  partial: { label: "חלקית", tone: "warning" },
  failed: { label: "נכשלה", tone: "danger" },
  skipped: { label: "דולגה", tone: "neutral" },
} as const;

const RECORD_PATH = { lead: paths.lead, contact: paths.contact, company: paths.company, deal: paths.deal } as const;

export default async function AutomationPage({ params, searchParams }: Props) {
  const { orgId, automationId } = await params;
  const query = await searchParams;
  const { role, canWrite, org } = await getOrgContext(orgId);
  // PRM-01: a member with the automations permission manages them too
  if (!canManageAutomations(role, await getMyPermissions(orgId)) || !isUuid(automationId)) {
    notFound();
  }
  const automation = await getAutomation(orgId, automationId);
  if (!automation) {
    notFound();
  }
  const [lookups, runs, records, people] = await Promise.all([
    getLookups(orgId),
    listRuns(orgId, automationId),
    listTestRecords(orgId, automation.entity),
    // PRM-01: who made the rule and who changed it last
    getUserNames([automation.createdBy, automation.updatedBy].filter((id): id is string => !!id)),
  ]);
  const description = describeRule(automation, lookups);
  // RET-01 (64) ג: right after a dormant rule is switched on, ask about the customers already dormant
  const today = zoneDate(new Date(), org.timeZone);
  const asked = query[DORMANT_ASK_PARAM] === "1" && canWrite && automation.isActive && automation.triggerType === DORMANT_TRIGGER;
  const dormantCount = asked ? await getDormantCount(orgId, automation.entity) : null;
  const askDormant = shouldAskDormant({
    asked,
    isActive: automation.isActive,
    triggerType: automation.triggerType,
    dormantFrom: automation.dormantFrom,
    today,
    count: dormantCount,
  });
  const missingReason = actionsMissingReason(automation.actions, lookups);

  return (
    <div className="space-y-5">
      <div>
        <Link href={paths.settingsAutomations(orgId)} className="mb-2 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
          <BackIcon className="size-4" />
          כל האוטומציות
        </Link>
        <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold break-words">
          {automation.name}
          {automation.isActive ? <Badge tone="success">פעילה</Badge> : <Badge>כבויה</Badge>}
        </h2>
        {/* PRM-01: an unknown last editor reads "לא ידוע" (owner) */}
        <p className="mt-1 text-sm text-ink-soft">{ruleAuthorshipLine(automation.createdBy, automation.updatedBy, people)}</p>
      </div>

      {askDormant && dormantCount ? <DormantActivationDialog orgId={orgId} automationId={automation.id} count={dormantCount} /> : null}

      {missingReason.length > 0 ? (
        <p role="note" className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          האוטומציה מעבירה ליד ל&quot;לא רלוונטי&quot; בלי סיבה מהרשימה. היא ממשיכה לרוץ והסיבה נשארת ריקה. כדאי להשלים סיבה.
          {canWrite ? (
            <Link href={paths.settingsAutomationEdit(orgId, automation.id)} className="font-medium underline underline-offset-4">
              לבחירת סיבה
            </Link>
          ) : null}
        </p>
      ) : null}

      <Card aria-labelledby="rule-title">
        <CardHeader
          id="rule-title"
          title="מה היא עושה"
          action={
            canWrite ? (
              <span className="flex flex-wrap gap-2">
                <Link href={paths.settingsAutomationEdit(orgId, automation.id)} className={buttonClasses("secondary", "sm")}>
                  עריכה
                </Link>
                <ActionButton action={setAutomationActiveAction.bind(null, orgId, automation.id, !automation.isActive)} pendingText="מעדכנים…">
                  {automation.isActive ? "כיבוי" : "הפעלה"}
                </ActionButton>
              </span>
            ) : null
          }
        />
        <CardBody className="space-y-3 text-md">
          <p>
            <span className="font-semibold">כאשר </span>
            {description.when}
          </p>
          {description.conditions.length > 0 ? (
            <div>
              <p className="font-semibold">אם</p>
              <ul className="ms-5 list-disc">
                {description.conditions.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {automation.triggerType === DORMANT_TRIGGER && automation.isActive && automation.dormantFrom ? (
            <p className="text-sm text-ink-soft">רצה על לקוחות שהפכו לרדומים מ-{formatDate(`${automation.dormantFrom}T12:00:00Z`)}, יום ההפעלה.</p>
          ) : null}
          <div>
            <p className="font-semibold">אז</p>
            <ol className="ms-5 list-decimal">
              {description.actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ol>
          </div>
        </CardBody>
      </Card>

      {canWrite ? (
        <Card aria-labelledby="test-title">
          <CardHeader id="test-title" title="הרצה על רשומה אחת" />
          <CardBody>
            <TestRunForm orgId={orgId} automationId={automation.id} records={records} />
          </CardBody>
        </Card>
      ) : null}

      <Card aria-labelledby="runs-title">
        <CardHeader id="runs-title" title="יומן הרצות" />
        {runs.length === 0 ? (
          <CardBody>
            <p className="text-md text-ink-soft">עוד לא רצה.</p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {runs.map((run) => {
              const status = RUN_STATUS[run.status as keyof typeof RUN_STATUS] ?? RUN_STATUS.skipped;
              const recordPath = RECORD_PATH[run.entityType as keyof typeof RECORD_PATH];
              const retry = retryLine(run, run.nextRetryAt ? formatDateTime(run.nextRetryAt) : null);
              return (
                <li key={run.id} className="space-y-1 px-4 py-3 sm:px-5">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={status.tone}>{quotaSkipLabel(run) ?? status.label}</Badge>
                    <span className="text-ink-soft">{formatDateTime(run.createdAt)}</span>
                    {recordPath ? (
                      <Link href={recordPath(orgId, run.entityId)} className="text-accent underline underline-offset-4">
                        לרשומה
                      </Link>
                    ) : run.entityType === "task" ? (
                      <Link href={paths.tasks(orgId)} className="text-accent underline underline-offset-4">
                        למשימות
                      </Link>
                    ) : null}
                  </p>
                  {run.steps.some((s) => s.status !== "ok" || s.warning) ? (
                    <ul className="text-sm">
                      {run.steps.map((step, i) => (
                        <li key={i} className={step.status !== "ok" ? "text-danger" : step.warning ? "text-warning" : "text-ink-soft"}>
                          {ACTION_LABELS[step.action as ActionType] ?? "הרצה"}:{" "}
                          {step.status !== "ok"
                            ? (STEP_ERRORS[step.error ?? ""] ?? step.error ?? "נכשל")
                            : step.warning
                              ? stepWarningTexts(step).join(" · ")
                              : "בוצע"}
                          {step.attempt ? ` (ניסיון ${step.attempt})` : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {retry ? <p className="text-sm text-ink-soft">{retry}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {canWrite ? (
        <ActionButton
          action={deleteAutomationAction.bind(null, orgId, automation.id)}
          pendingText="מוחקים…"
          variant="danger-ghost"
          confirm={`למחוק את האוטומציה "${automation.name}" ואת היומן שלה?`}
        >
          מחיקה
        </ActionButton>
      ) : null}
    </div>
  );
}
