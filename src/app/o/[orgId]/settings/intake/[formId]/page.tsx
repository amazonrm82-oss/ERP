import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ChevronIcon } from "@/components/ui/icons";
import { deleteIntakeAction } from "@/features/intake/actions";
import { CopyBlock, IntakeSettingsForm } from "@/features/intake/components/intake-editor";
import { getIntake, listSubmissions } from "@/features/intake/queries";
import { getLeadLookups } from "@/features/leads/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { listMembers, listTeams } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatDateTime } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";

export const metadata: Metadata = { title: "ערוץ קליטה" };

type Props = { params: Promise<{ orgId: string; formId: string }> };

export default async function IntakeItemPage({ params }: Props) {
  const { orgId, formId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isUuid(formId) || !isAdminRole(role)) {
    notFound();
  }
  const [intake, submissions, lookups, members, teams, origin] = await Promise.all([
    getIntake(orgId, formId),
    listSubmissions(orgId, formId),
    getLeadLookups(orgId),
    listMembers(orgId),
    listTeams(orgId),
    siteOrigin(),
  ]);
  if (!intake) {
    notFound();
  }
  const sources = lookups.sources.filter((source) => source.isActive || source.id === intake.sourceId);
  const assignable = members
    .filter((member) => member.status === "active" && member.role !== "viewer")
    .map((member) => ({ id: member.userId, name: member.name }));

  const pageUrl = `${origin}/f/${intake.token}`;
  const postUrl = `${origin}/api/forms/${intake.token}`;
  const hookUrl = `${origin}/api/in/${intake.token}`;

  return (
    <div className="space-y-5">
      <div>
        <Link href={paths.settingsIntake(orgId)} className="mb-2 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
          <ChevronIcon className="size-4 rtl:rotate-180" />
          כל ערוצי הקליטה
        </Link>
        <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold break-words">
          {intake.name}
          <Badge>{intake.kind === "form" ? "טופס" : "Webhook"}</Badge>
          {intake.isActive ? null : <Badge tone="warning">כבוי</Badge>}
        </h2>
      </div>

      {intake.kind === "form" ? (
        <Card aria-labelledby="embed-title">
          <CardHeader id="embed-title" title="איך מחברים לאתר" />
          <CardBody className="space-y-5">
            <p className="text-[0.9375rem] text-ink-soft">
              הדרך הפשוטה: להדביק את הקוד הזה באתר במקום שבו הטופס צריך להופיע. אפשר גם לשלוח את הקישור ישירות, למשל ב-WhatsApp
              או במודעה.
            </p>
            <CopyBlock
              label="קוד להטמעה באתר"
              value={`<iframe src="${pageUrl}?embed=1" title="${(intake.title ?? intake.name).replace(/"/g, "&quot;")}" style="width:100%;max-width:480px;height:560px;border:0" loading="lazy"></iframe>`}
            />
            <CopyBlock label="קישור ישיר לטופס" value={pageUrl} />
            <details className="text-[0.9375rem]">
              <summary className="cursor-pointer font-medium">לבוני אתרים: שליחה מטופס קיים</summary>
              <div className="mt-3 space-y-3">
                <p className="text-ink-soft">
                  טופס HTML קיים יכול לשלוח ישירות לכתובת הזו (POST). שמות השדות: full_name, phone, email, company_name, message.
                </p>
                <CopyBlock label="כתובת שליחה" value={postUrl} />
              </div>
            </details>
          </CardBody>
        </Card>
      ) : (
        <Card aria-labelledby="hook-title">
          <CardHeader id="hook-title" title="חיבור ה-webhook" />
          <CardBody className="space-y-4">
            <p className="text-[0.9375rem] text-ink-soft">
              הכתובת היא הסיסמה: מי שמחזיק בה יכול ליצור לידים. לא לפרסם אותה באתר. שולחים POST עם JSON, עם השדות full_name, phone,
              email, company_name, message (גם name, company ו-notes מתקבלים).
            </p>
            <CopyBlock label="כתובת ה-webhook" value={hookUrl} />
            <CopyBlock
              label="דוגמה לבדיקה"
              value={`curl -X POST "${hookUrl}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"full_name":"ישראל ישראלי","phone":"050-1234567","email":"israel@example.com"}'`}
            />
          </CardBody>
        </Card>
      )}

      <Card aria-labelledby="intake-settings-title">
        <CardHeader id="intake-settings-title" title="הגדרות" />
        <CardBody>
          {canWrite ? (
            <IntakeSettingsForm
              orgId={orgId}
              intake={intake}
              sources={sources}
              members={assignable}
              teams={teams.map((team) => ({ id: team.id, name: team.name }))}
            />
          ) : (
            <p className="text-[0.9375rem] text-ink-soft">החשבון במצב קריאה בלבד.</p>
          )}
        </CardBody>
      </Card>

      <Card aria-labelledby="submissions-title">
        <CardHeader id="submissions-title" title="פניות אחרונות" />
        {submissions.length === 0 ? (
          <CardBody>
            <p className="text-[0.9375rem] text-ink-soft">עוד לא התקבלו פניות.</p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {submissions.map((submission) => (
              <li key={submission.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
                <span className="min-w-0">
                  {submission.leadId ? (
                    <Link href={paths.lead(orgId, submission.leadId)} className="font-medium underline-offset-4 hover:underline">
                      {submission.summary}
                    </Link>
                  ) : (
                    <span className="font-medium text-ink-soft">{submission.summary}</span>
                  )}
                  <span className="block text-sm text-ink-soft">{formatDateTime(submission.createdAt)}</span>
                </span>
                {submission.status === "spam" ? (
                  <Badge tone="warning">ספאם, לא נוצר ליד</Badge>
                ) : submission.status === "duplicate" ? (
                  <Badge tone="accent">פנייה חוזרת, נוספה לרשומה קיימת</Badge>
                ) : (
                  <Badge tone="success">ליד נוצר</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canWrite ? (
        <ActionButton
          action={deleteIntakeAction.bind(null, orgId, intake.id)}
          pendingText="מוחק…"
          variant="danger-ghost"
          confirm={`למחוק את "${intake.name}"? הכתובת תפסיק לעבוד מייד. הלידים שכבר נוצרו נשארים.`}
        >
          מחיקה
        </ActionButton>
      ) : null}
    </div>
  );
}
