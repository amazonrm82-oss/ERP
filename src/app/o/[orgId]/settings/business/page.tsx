import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { INDUSTRIES, TEAM_SIZES } from "@/features/onboarding/options";
import { BrandingSettings } from "@/features/branding/components/branding-settings";
import { getOrgBranding } from "@/features/branding/queries";
import { OrgSecurityCard } from "@/features/account/components/org-security-card";
import { OrganizationSettingsForm } from "@/features/settings/components/organization-settings-form";
import { isAdminRole, VISIBILITY_OPTIONS } from "@/features/settings/permissions";
import { getOrganizationSettings } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { SupportAccessCard } from "@/features/support/components/support-access-card";
import { getOpenSupportGrant } from "@/features/support/queries";

export const metadata: Metadata = { title: "פרטי העסק" };

type Props = { params: Promise<{ orgId: string }> };

export default async function OrganizationSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const settings = await getOrganizationSettings(orgId);
  if (!settings) {
    notFound();
  }

  // the database lets admins edit even a read-only organization's profile,
  // but the screen follows the general rule: nothing changes while read-only
  if (isAdminRole(role) && canWrite) {
    const [grant, branding] = await Promise.all([getOpenSupportGrant(orgId), getOrgBranding(orgId)]);
    return (
      <>
        <OrganizationSettingsForm orgId={orgId} settings={settings} />
        <BrandingSettings orgId={orgId} logoUrl={branding.logoUrl} color={branding.color} />
        <OrgSecurityCard orgId={orgId} requireMfa={settings.requireMfa} />
        <SupportAccessCard orgId={orgId} grant={grant} />
      </>
    );
  }

  // support may be needed most when the account is read-only, so admins can always open it
  const grant = isAdminRole(role) ? await getOpenSupportGrant(orgId) : null;
  return (
    <>
      <Card aria-labelledby="org-details-title">
        <CardHeader id="org-details-title" title="פרטי העסק" />
        <CardBody>
          <DetailList>
            <Detail label="שם העסק" value={settings.name} />
            <Detail label="ענף" value={INDUSTRIES.find((o) => o.value === settings.industry)?.label} />
            <Detail label="גודל צוות" value={TEAM_SIZES.find((o) => o.value === settings.teamSize)?.label} />
            <Detail label="טלפון" value={settings.phone} ltr />
            <Detail label="מי רואה רשומות" value={VISIBILITY_OPTIONS.find((o) => o.value === settings.recordVisibility)?.label} />
          </DetailList>
          {isAdminRole(role) ? null : <p className="mt-4 text-sm text-ink-soft">רק בעלים ומנהלי מערכת יכולים לשנות את הפרטים.</p>}
        </CardBody>
      </Card>
      {isAdminRole(role) ? <SupportAccessCard orgId={orgId} grant={grant} /> : null}
    </>
  );
}
