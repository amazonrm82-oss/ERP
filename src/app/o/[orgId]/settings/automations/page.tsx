import type { Metadata } from "next";
import Link from "next/link";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { BoltIcon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/feedback";
import { createFromTemplateAction } from "@/features/automations/actions";
import { actionsMissingReason } from "@/features/automations/convert";
import { describeRule } from "@/features/automations/describe";
import { getLookups, listAutomations } from "@/features/automations/queries";
import { runQuotaState } from "@/features/automations/run-quota";
import { TEMPLATES } from "@/features/automations/templates";
import { canManageAutomations } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { getPlanUsage } from "@/features/settings/plan-usage";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "אוטומציות" };

type Props = { params: Promise<{ orgId: string }> };

export default async function AutomationsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  // PRM-01: a member with the automations permission manages them too
  if (!canManageAutomations(role, await getMyPermissions(orgId))) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState kind="locked" title="אין גישה" description="אוטומציות מנוהלות על ידי הבעלים, מנהלי המערכת ומי שקיבל הרשאה לכך." />
      </div>
    );
  }
  const [automations, lookups, plan] = await Promise.all([listAutomations(orgId), getLookups(orgId), getPlanUsage(orgId)]);
  // AUT-07: the month's runs against the plan
  const runs = plan?.usage.find((row) => row.key === "max_automation_runs_per_month");
  const quota = runs ? runQuotaState(runs.used, runs.limit) : null;
  const used = new Set(automations.map((a) => a.templateKey).filter(Boolean));

  return (
    <div className="space-y-5">
      {quota ? (
        <div
          role={quota.level === "stopped" ? "alert" : "status"}
          className={
            quota.level === "stopped"
              ? "rounded-lg border border-danger bg-danger-soft px-4 py-3 text-md text-danger sm:px-5"
              : "rounded-lg border border-warning bg-warning-soft px-4 py-3 text-md text-warning sm:px-5"
          }
        >
          {quota.text} <Link href={paths.settingsPlan(orgId)} className="underline">לחבילה ולשימוש</Link>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-md text-ink-soft">
          אוטומציה עושה עבודה קבועה בשבילכם: כאשר משהו קורה, ואם התנאים מתקיימים, היא מבצעת פעולות. היא רצה תוך דקה מהאירוע (ובדיקות
          של זמן, כמו &quot;עסקה תקועה&quot;, כל רבע שעה).
        </p>
        {canWrite ? <ButtonLink href={paths.settingsAutomationNew(orgId)}>אוטומציה חדשה</ButtonLink> : null}
      </div>

      <Card aria-labelledby="automations-title">
        <CardHeader id="automations-title" title="האוטומציות שלכם" />
        {automations.length === 0 ? (
          <EmptyState icon={<BoltIcon />} title="עוד אין אוטומציות" description="אפשר להתחיל מתבנית מוכנה למטה, או לבנות אחת חדשה." />
        ) : (
          <ul className="divide-y divide-line">
            {automations.map((automation) => {
              const description = describeRule(automation, lookups);
              return (
                <li key={automation.id}>
                  <Link href={paths.settingsAutomation(orgId, automation.id)} className="block px-4 py-3 hover:bg-canvas sm:px-5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{automation.name}</span>
                      {automation.isActive ? <Badge tone="success">פעילה</Badge> : <Badge>כבויה</Badge>}
                      {automation.failed7d > 0 ? <Badge tone="danger">{automation.failed7d} כשלים השבוע</Badge> : null}
                      {actionsMissingReason(automation.actions, lookups).length > 0 ? <Badge tone="warning">חסרה סיבה ל&quot;לא רלוונטי&quot;</Badge> : null}
                    </span>
                    <span className="mt-0.5 block text-sm text-ink-soft">
                      כאשר {description.when}. {automation.runs7d} הרצות ב-7 הימים האחרונים.
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card aria-labelledby="templates-title">
        <CardHeader id="templates-title" title="תבניות מוכנות" />
        <ul className="divide-y divide-line">
          {TEMPLATES.map((template) => (
            <li key={template.key} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 sm:px-5">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{template.title}</p>
                <p className="text-sm text-ink-soft">{template.description}</p>
                {template.unavailable ? <p className="mt-1 text-sm text-warning">{template.unavailable}</p> : null}
              </div>
              {template.unavailable || !canWrite ? (
                <Badge>בקרוב</Badge>
              ) : used.has(template.key) ? (
                <Badge tone="success">נוספה</Badge>
              ) : (
                <ActionButton action={createFromTemplateAction.bind(null, orgId, template.key)} pendingText="מוסיפים…" srLabel={template.title}>
                  הוספה
                </ActionButton>
              )}
            </li>
          ))}
        </ul>
        <CardBody className="border-t border-line text-sm text-ink-soft">
          שליחת WhatsApp, אימייל ו-SMS אוטומטית תתווסף כשיחוברו הערוצים. עד אז התבניות יוצרות משימה לאחראי.
        </CardBody>
      </Card>
    </div>
  );
}
