import type { Metadata } from "next";
import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { Checkbox, SelectField, TextareaField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { addBannerAction, endBannerAction } from "@/features/platform/banner-actions";
import { listAdminBanners } from "@/features/platform/banner-queries";
import {
  BANNER_MAX_LENGTH,
  BANNER_MAX_ORGS,
  BANNER_SEVERITY_LABELS,
  BANNER_STATUS_LABELS,
  BANNER_TARGET_LABELS,
  bannerStatus,
  type AdminBanner,
  type BannerStatus,
} from "@/features/platform/banners";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { canDo } from "@/features/platform/labels";
import { listPlans, platformReady } from "@/features/platform/queries";
import { formatDateTime, zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "הודעות מערכת" };

const STATUS_TONES: Record<BannerStatus, BadgeTone> = { live: "success", upcoming: "accent", ended: "neutral" };

function targetLine(banner: AdminBanner, planNames: Map<string, string>) {
  if (banner.target === "plan") return `חבילה: ${planNames.get(banner.targetPlan ?? "") ?? banner.targetPlan}`;
  if (banner.target === "all") return BANNER_TARGET_LABELS.all;
  return null;
}

// ADM-04: a banner at the top of every business screen, to every business or some of them. Everyone on the platform
// staff sees the list; the platform owner and support add and end banners (logged, with two-step verification).
export default async function AdminBannersPage() {
  const me = await platformReady();
  if (!me) return null;
  const [banners, plans] = await Promise.all([listAdminBanners(), listPlans()]);
  const canEdit = canDo(me.role, ["support"]);
  const planNames = new Map(plans.map((plan) => [plan.key, plan.name_he]));
  const today = zoneDate(new Date());

  return (
    <>
      <PageHeader
        title="הודעות מערכת"
        description="הודעה קצרה בראש כל מסך של העסק, לכל העסקים או לחלקם. הודעת מידע אפשר תמיד לסגור; אזהרה אפשר להשאיר פתוחה עד סוף התקופה. כל אדם סוגר הודעה לעצמו, בכל המכשירים."
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card aria-labelledby="banner-list">
          <CardHeader id="banner-list" title="ההודעות" />
          {banners.length === 0 ? (
            <p className="px-4 py-5 text-ink-soft sm:px-5">עוד לא נשלחו הודעות.</p>
          ) : (
            <ul className="divide-y divide-line">
              {banners.map((banner) => {
                const status = bannerStatus(banner);
                const line = targetLine(banner, planNames);
                return (
                  <li key={banner.id} className="space-y-2 px-4 py-3 sm:px-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 font-medium break-words">{banner.body}</p>
                      <div className="flex shrink-0 flex-wrap gap-1.5">
                        <Badge tone={banner.severity === "warning" ? "warning" : "neutral"}>{BANNER_SEVERITY_LABELS[banner.severity]}</Badge>
                        <Badge tone={STATUS_TONES[status]}>{BANNER_STATUS_LABELS[status]}</Badge>
                      </div>
                    </div>
                    <p className="text-sm text-ink-soft">
                      {formatDateTime(banner.startsAt)} עד {formatDateTime(banner.endedAt ?? banner.endsAt)}
                      {banner.dismissable ? ` · נסגרה על ידי ${banner.dismissals.toLocaleString("he-IL")}` : " · אי אפשר לסגור"}
                    </p>
                    {line ? <p className="text-sm text-ink-soft">{line}</p> : null}
                    {banner.target === "orgs" ? (
                      <p className="text-sm text-ink-soft">
                        עסקים:{" "}
                        {banner.targetOrgs.map((org, index) => (
                          <span key={org.id}>
                            {index > 0 ? ", " : null}
                            <Link href={paths.adminOrg(org.id)} className="text-accent-strong underline underline-offset-4">
                              {org.name}
                            </Link>
                          </span>
                        ))}
                      </p>
                    ) : null}
                    {canEdit && status !== "ended" ? (
                      <ConfirmButton
                        title="להסיר את ההודעה?"
                        description="ההודעה תיעלם מכל העסקים בטעינה הבאה של הדף. הפעולה נרשמת ביומן."
                        confirmLabel="הסרה"
                        action={endBannerAction.bind(null, banner.id)}
                      >
                        הסרת ההודעה עכשיו
                      </ConfirmButton>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {canEdit ? (
          <Card aria-labelledby="banner-new">
            <CardHeader id="banner-new" title="הודעה חדשה" />
            <CardBody>
              <PlatformForm action={addBannerAction} submitLabel="שמירה והצגה">
                <TextareaField label="ההודעה" name="body" maxLength={BANNER_MAX_LENGTH} required hint={`שורה אחת, עד ${BANNER_MAX_LENGTH} תווים. בלי פרטים של לקוח.`} />
                <SelectField label="סוג" name="severity" defaultValue="info">
                  <option value="info">{BANNER_SEVERITY_LABELS.info}</option>
                  <option value="warning">{BANNER_SEVERITY_LABELS.warning}</option>
                </SelectField>
                <Checkbox name="dismissable" defaultChecked label="אפשר לסגור את ההודעה" hint="רק אזהרה יכולה להישאר פתוחה. הודעת מידע תמיד אפשר לסגור." />
                <DateField label="מתאריך" name="starts_on" defaultValue={today} min={today} hint="ריק או היום: מיד." />
                <DateField label="עד תאריך (כולל)" name="ends_on" min={today} required />
                <SelectField label="למי" name="target" defaultValue="all">
                  <option value="all">{BANNER_TARGET_LABELS.all}</option>
                  <option value="orgs">{BANNER_TARGET_LABELS.orgs}</option>
                  <option value="plan">{BANNER_TARGET_LABELS.plan}</option>
                </SelectField>
                <TextareaField
                  label="מזהי עסקים"
                  name="orgs"
                  dir="ltr"
                  hint={`רק כש"עסקים מסוימים" נבחר: מזהה או כתובת של כרטיס עסק בכל שורה. עד ${BANNER_MAX_ORGS}.`}
                />
                <SelectField label="חבילה" name="plan" defaultValue="" hint={`רק כש"עסקים בחבילה" נבחר.`}>
                  <option value="">בחירה</option>
                  {plans.map((plan) => (
                    <option key={plan.key} value={plan.key}>
                      {plan.name_he}
                    </option>
                  ))}
                </SelectField>
              </PlatformForm>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
