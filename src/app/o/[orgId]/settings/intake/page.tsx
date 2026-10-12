import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { ForwardIcon, FormIcon } from "@/components/ui/icons";
import { CreateIntakeForm } from "@/features/intake/components/intake-editor";
import { SubmissionList } from "@/features/intake/components/submission-list";
import { listIntakes, listKeptSubmissions } from "@/features/intake/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "טפסים וחיבורים" };

type Props = { params: Promise<{ orgId: string }> };

export default async function IntakeSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isAdminRole(role)) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState kind="locked" title="אין גישה" description="טפסים וחיבורים מנוהלים על ידי הבעלים ומנהלי המערכת." />
      </div>
    );
  }
  const [intakes, kept] = await Promise.all([listIntakes(orgId), listKeptSubmissions(orgId)]);

  return (
    <div className="space-y-5">
      <p className="text-md text-ink-soft">
        לידים נכנסים מעצמם: מטופס שמטמיעים באתר, או מ-webhook שמחברים למערכת אחרת (Zapier, Make, תוסף לאתר). כל פנייה הופכת לליד עם
        המקור והאחראי שבחרתם.
      </p>
      {canWrite ? (
        <Card aria-labelledby="new-intake-title">
          <CardHeader id="new-intake-title" title="טופס או webhook חדש" />
          <CardBody>
            <CreateIntakeForm orgId={orgId} />
          </CardBody>
        </Card>
      ) : null}
      <Card aria-labelledby="intakes-title">
        <CardHeader id="intakes-title" title="טפסים וחיבורים" />
        {intakes.length === 0 ? (
          <EmptyState icon={<FormIcon />} title="עוד אין טפסים" description="צרו טופס, הטמיעו אותו באתר, וכל פנייה תיכנס כאן כליד." />
        ) : (
          <ul className="divide-y divide-line">
            {intakes.map((intake) => (
              <li key={intake.id}>
                <Link
                  href={paths.settingsIntakeItem(orgId, intake.id)}
                  className="flex min-h-16 items-center justify-between gap-3 px-4 py-3 hover:bg-canvas sm:px-5"
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{intake.name}</span>
                      <Badge>{intake.kind === "form" ? "טופס" : "Webhook"}</Badge>
                      {intake.isActive ? null : <Badge tone="warning">כבוי</Badge>}
                    </span>
                    <span className="block text-sm text-ink-soft">
                      {intake.submissions30d === 1 ? "ליד אחד" : `${intake.submissions30d} לידים`} ב-30 הימים האחרונים
                    </span>
                  </span>
                  <ForwardIcon className="size-5 shrink-0 text-ink-soft" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {kept.length > 0 ? (
        <Card aria-labelledby="kept-submissions-title">
          <CardHeader id="kept-submissions-title" title="פניות מטפסים שנמחקו" />
          <p className="px-4 pt-3 text-md text-ink-soft sm:px-5">הטופס נמחק, אבל הפניות שהגיעו ממנו נשמרות כאן 12 חודשים מיום המחיקה. הלידים שנוצרו מהן נשארים.</p>
          <SubmissionList orgId={orgId} submissions={kept} />
        </Card>
      ) : null}
    </div>
  );
}
