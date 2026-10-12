import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getPipeline } from "@/features/deals/queries";
import { getLeadLookups } from "@/features/leads/queries";
import { InviteForm } from "@/features/settings/components/invite-form";
import { assignableRoles, isAdminRole } from "@/features/settings/permissions";
import { getOrganizationSettings, listPendingInvitations, orgHasFeature } from "@/features/settings/queries";
import { continueSetupAction, startSetupImportAction } from "@/features/setup/actions";
import { DetailsStepForm } from "@/features/setup/components/details-step-form";
import { IndustryStepForm } from "@/features/setup/components/industry-step-form";
import { SetupProgress } from "@/features/setup/components/setup-progress";
import { StepActionButton } from "@/features/setup/components/step-action-button";
import { getSetupStep } from "@/features/setup/queries";
import { setupStepTitle, stepToShow, type SetupStep } from "@/features/setup/steps";
import { getOrgContext } from "@/features/shell/queries";
import type { MembershipRole } from "@/lib/database.types";
import { formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "הקמת העסק" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ step?: string | string[] }>;
};

export default async function SetupPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const { org, role, canWrite } = await getOrgContext(orgId);
  // the wizard is for owners and admins of a writable business; everyone else goes straight to the app
  if (!isAdminRole(role) || !canWrite) {
    redirect(paths.org(orgId));
  }
  const step = stepToShow(await getSetupStep(orgId), (await searchParams).step);
  if (!step) {
    redirect(paths.org(orgId));
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader title="הקמת העסק" description="ארבעה צעדים קצרים. אפשר לדלג על כל שלב, ולחזור לכאן מהמסך הראשי." />
      <SetupProgress orgId={orgId} step={step} />
      <Card aria-labelledby="setup-step-title">
        <CardHeader id="setup-step-title" title={setupStepTitle(step)} />
        <CardBody>
          {step === 1 ? <DetailsStep orgId={orgId} /> : null}
          {step === 2 ? <IndustryStep orgId={orgId} /> : null}
          {step === 3 ? <ImportStep orgId={orgId} /> : null}
          {step === 4 ? <InviteStep orgId={orgId} orgName={org.name} role={role} /> : null}
        </CardBody>
      </Card>
      <StepFooter orgId={orgId} step={step} />
    </div>
  );
}

async function DetailsStep({ orgId }: { orgId: string }) {
  const settings = await getOrganizationSettings(orgId);
  if (!settings) {
    notFound();
  }
  return (
    <>
      <p className="mb-4 text-md text-ink-soft">בדקו שהפרטים נכונים, ובחרו מי בעסק רואה אילו רשומות.</p>
      <DetailsStepForm orgId={orgId} settings={settings} />
    </>
  );
}

async function IndustryStep({ orgId }: { orgId: string }) {
  const [settings, pipeline, lookups] = await Promise.all([getOrganizationSettings(orgId), getPipeline(orgId), getLeadLookups(orgId)]);
  if (!settings) {
    notFound();
  }
  const lists = [
    { title: "שלבי המכירה", names: pipeline?.stages.map((s) => s.name) ?? [], href: paths.settingsPipelines(orgId) },
    { title: "סטטוסים של ליד", names: lookups.statuses.map((s) => s.name), href: paths.settingsLeads(orgId) },
    { title: "מקורות לידים", names: lookups.sources.filter((s) => s.isActive).map((s) => s.name), href: paths.settingsLeads(orgId) },
  ];
  return (
    <>
      <IndustryStepForm orgId={orgId} industry={settings.industry} />
      <section aria-labelledby="setup-lists-title" className="mt-6 border-t border-line pt-5">
        <h3 id="setup-lists-title" className="font-semibold">
          מה כבר מוכן בשבילכם
        </h3>
        <p className="mt-1 mb-4 text-sm text-ink-soft">אלה הרשימות שהעסק התחיל איתן. אפשר לשנות, להוסיף ולמחוק בכל זמן בהגדרות.</p>
        <ul className="space-y-4">
          {lists.map((list) => (
            <li key={list.title}>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3">
                <h4 className="text-md font-medium">{list.title}</h4>
                <Link href={list.href} className="text-sm text-accent-strong underline underline-offset-4">
                  {`לשינוי ${list.title}`}
                </Link>
              </div>
              {list.names.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5" aria-label={list.title}>
                  {list.names.map((name, index) => (
                    <li key={`${index}-${name}`}>
                      <Badge>{name}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-soft">הרשימה ריקה.</p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function ImportStep({ orgId }: { orgId: string }) {
  return (
    <>
      <p className="text-md">יש לכם לקוחות או לידים בקובץ Excel או CSV? מעלים את הקובץ, בוחרים איזו עמודה היא מה, ובודקים לפני שמייבאים.</p>
      <p className="mt-2 mb-5 text-sm text-ink-soft">אפשר לבטל ייבוא אחרי שהסתיים. אחרי הייבוא תחזרו להקמה מהמסך הראשי.</p>
      <div className="flex flex-wrap items-center gap-3">
        <StepActionButton action={startSetupImportAction.bind(null, orgId)} variant="primary" pendingText="פותחים…">
          לייבוא מקובץ
        </StepActionButton>
      </div>
    </>
  );
}

async function InviteStep({ orgId, orgName, role }: { orgId: string; orgName: string; role: MembershipRole }) {
  const [hasViewSeats, invitations] = await Promise.all([orgHasFeature(orgId, "view_seats"), listPendingInvitations(orgId)]);
  return (
    <>
      <p className="mb-4 text-md text-ink-soft">כל עובד מקבל קישור הצטרפות משלו. שולחים לו אותו בוואטסאפ או באימייל.</p>
      <InviteForm orgId={orgId} orgName={orgName} roles={assignableRoles(role, hasViewSeats)} />
      {invitations.length > 0 ? (
        <p className="mt-4 text-sm text-ink-soft">
          {`הזמנות שמחכות לאישור: ${formatNumber(invitations.length)}. `}
          <Link href={paths.settingsUsers(orgId)} className="text-accent-strong underline underline-offset-4">
            לרשימת המשתמשים
          </Link>
        </p>
      ) : null}
    </>
  );
}

/** Below every step: skip it (the last one: finish), go back one step, or leave for now. */
function StepFooter({ orgId, step }: { orgId: string; step: SetupStep }) {
  const last = step === 4;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <StepActionButton action={continueSetupAction.bind(null, orgId, step)} variant={last ? "primary" : "secondary"}>
        {last ? "סיום ההקמה" : "דילוג על השלב"}
      </StepActionButton>
      {step > 1 ? (
        <Link href={paths.setup(orgId, step - 1)} className="min-h-11 content-center px-2 text-md text-ink-soft underline-offset-4 hover:text-ink hover:underline">
          חזרה
        </Link>
      ) : null}
      <Link href={paths.org(orgId)} className="ms-auto min-h-11 content-center px-2 text-md text-ink-soft underline-offset-4 hover:text-ink hover:underline">
        להמשיך אחר כך
      </Link>
    </div>
  );
}
