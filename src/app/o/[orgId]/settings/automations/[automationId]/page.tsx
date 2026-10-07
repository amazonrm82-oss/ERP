import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ChevronIcon } from "@/components/ui/icons";
import { deleteAutomationAction, setAutomationActiveAction } from "@/features/automations/actions";
import { TestRunForm } from "@/features/automations/components/test-run-form";
import { ACTION_LABELS, type ActionType } from "@/features/automations/definitions";
import { describeRule, STEP_ERRORS } from "@/features/automations/describe";
import { getAutomation, getLookups, listRuns, listTestRecords } from "@/features/automations/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { formatDateTime } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "אוטומציה" };

type Props = { params: Promise<{ orgId: string; automationId: string }> };

const RUN_STATUS = {
  success: { label: "הצליחה", tone: "success" },
  partial: { label: "חלקית", tone: "warning" },
  failed: { label: "נכשלה", tone: "danger" },
  skipped: { label: "דולגה", tone: "neutral" },
} as const;

const RECORD_PATH = { lead: paths.lead, contact: paths.contact, company: paths.company, deal: paths.deal } as const;

export default async function AutomationPage({ params }: Props) {
  const { orgId, automationId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isAdminRole(role) || !isUuid(automationId)) {
    notFound();
  }
  const automation = await getAutomation(orgId, automationId);
  if (!automation) {
    notFound();
  }
  const [lookups, runs, records] = await Promise.all([getLookups(orgId), listRuns(orgId, automationId), listTestRecords(orgId, automation.entity)]);
  const description = describeRule(automation, lookups);

  return (
    <div className="space-y-5">
      <div>
        <Link href={paths.settingsAutomations(orgId)} className="mb-2 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
          <ChevronIcon className="size-4 rtl:rotate-180" />
          כל האוטומציות
        </Link>
        <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold break-words">
          {automation.name}
          {automation.isActive ? <Badge tone="success">פעילה</Badge> : <Badge>כבויה</Badge>}
        </h2>
      </div>

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
                <ActionButton action={setAutomationActiveAction.bind(null, orgId, automation.id, !automation.isActive)} pendingText="מעדכן…">
                  {automation.isActive ? "כיבוי" : "הפעלה"}
                </ActionButton>
              </span>
            ) : null
          }
        />
        <CardBody className="space-y-3 text-[0.9375rem]">
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
          <CardHeader id="test-title" title="בדיקה על רשומה אחת" />
          <CardBody>
            <TestRunForm orgId={orgId} automationId={automation.id} records={records} />
          </CardBody>
        </Card>
      ) : null}

      <Card aria-labelledby="runs-title">
        <CardHeader id="runs-title" title="יומן הרצות" />
        {runs.length === 0 ? (
          <CardBody>
            <p className="text-[0.9375rem] text-ink-soft">עוד לא רצה.</p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {runs.map((run) => {
              const status = RUN_STATUS[run.status as keyof typeof RUN_STATUS] ?? RUN_STATUS.skipped;
              const recordPath = RECORD_PATH[run.entityType as keyof typeof RECORD_PATH];
              return (
                <li key={run.id} className="space-y-1 px-4 py-3 sm:px-5">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={status.tone}>{status.label}</Badge>
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
                  {run.steps.some((s) => s.status !== "ok") ? (
                    <ul className="text-sm">
                      {run.steps.map((step, i) => (
                        <li key={i} className={step.status === "ok" ? "text-ink-soft" : "text-danger"}>
                          {ACTION_LABELS[step.action as ActionType] ?? "הרצה"}: {step.status === "ok" ? "בוצע" : (STEP_ERRORS[step.error ?? ""] ?? step.error ?? "נכשל")}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {canWrite ? (
        <ActionButton
          action={deleteAutomationAction.bind(null, orgId, automation.id)}
          pendingText="מוחק…"
          variant="danger-ghost"
          confirm={`למחוק את האוטומציה "${automation.name}" ואת היומן שלה?`}
        >
          מחיקה
        </ActionButton>
      ) : null}
    </div>
  );
}
