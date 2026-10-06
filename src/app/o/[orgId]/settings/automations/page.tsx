import type { Metadata } from "next";
import Link from "next/link";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { createFromTemplateAction } from "@/features/automations/actions";
import { describeRule } from "@/features/automations/describe";
import { getLookups, listAutomations } from "@/features/automations/queries";
import { TEMPLATES } from "@/features/automations/templates";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "אוטומציות" };

type Props = { params: Promise<{ orgId: string }> };

export default async function AutomationsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isAdminRole(role)) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState title="אין גישה" description="אוטומציות מנוהלות על ידי הבעלים ומנהלי המערכת." />
      </div>
    );
  }
  const [automations, lookups] = await Promise.all([listAutomations(orgId), getLookups(orgId)]);
  const used = new Set(automations.map((a) => a.templateKey).filter(Boolean));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[0.9375rem] text-ink-soft">
          אוטומציה עושה עבודה קבועה בשבילכם: כאשר משהו קורה, ואם התנאים מתקיימים, היא מבצעת פעולות. היא רצה תוך דקה מהאירוע (ובדיקות
          של זמן, כמו &quot;עסקה תקועה&quot;, כל רבע שעה).
        </p>
        {canWrite ? <ButtonLink href={paths.settingsAutomationNew(orgId)}>אוטומציה חדשה</ButtonLink> : null}
      </div>

      <Card aria-labelledby="automations-title">
        <CardHeader id="automations-title" title="האוטומציות שלכם" />
        {automations.length === 0 ? (
          <EmptyState title="עוד אין אוטומציות" description="אפשר להתחיל מתבנית מוכנה למטה, או לבנות אחת חדשה." />
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
                <ActionButton action={createFromTemplateAction.bind(null, orgId, template.key)} pendingText="מוסיף…" srLabel={template.title}>
                  הוספה
                </ActionButton>
              )}
            </li>
          ))}
        </ul>
        <CardBody className="border-t border-line text-sm text-ink-soft">
          שליחת WhatsApp, אימייל ו-SMS אוטומטית תתווסף כשיחוברו הערוצים. עד אז התבניות יוצרות משימה לנציג.
        </CardBody>
      </Card>
    </div>
  );
}
