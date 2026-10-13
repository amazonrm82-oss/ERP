import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { businessPlanCanOpen } from "@/features/plans/capabilities";
import { annualPriceLabel, AVAILABILITY_LABELS, monthlyPriceLabel, VAT_NOTE } from "@/features/plans/price";
import { setPlanAvailabilityAction, updatePlanAction } from "@/features/platform/actions";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { getPlanWaitlistCounts, listPlans, platformReady } from "@/features/platform/queries";
import { formatNumber } from "@/lib/format";

export const metadata: Metadata = { title: "חבילות" };

const shekels = (agorot: number) => String(agorot / 100);

export default async function AdminPlansPage() {
  const me = await platformReady();
  if (!me) return null;
  const [plans, waiting] = await Promise.all([listPlans(), getPlanWaitlistCounts()]);
  const canEdit = me.role === "owner";
  const business = plans.find((plan) => plan.key === "business");

  return (
    <>
      <PageHeader
        title="חבילות"
        description={`מחירים ${VAT_NOTE}, לחודש, לעסק או למשתמש לפי החבילה. שינוי חל מיד על כל הארגונים בחבילה (חוץ מדריסות לארגון בודד).`}
      />
      {businessPlanCanOpen(business?.availability) ? (
        <p role="status" className="mb-5 rounded-md bg-accent-soft px-3 py-2.5 text-md">
          אפשר לפתוח את החבילה &apos;עסקי&apos;.
        </p>
      ) : null}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        {plans.map((plan) => (
          <Card key={plan.key} aria-labelledby={`plan-${plan.key}`}>
            <CardHeader id={`plan-${plan.key}`} title={`${plan.name_he} (${plan.key})`} />
            <CardBody className="space-y-4">
              <div className="space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={plan.availability === "available" ? "success" : plan.availability === "coming_soon" ? "accent" : "neutral"}>
                    {AVAILABILITY_LABELS[plan.availability] ?? plan.availability}
                  </Badge>
                  {monthlyPriceLabel(plan)}, {annualPriceLabel(plan)}. {VAT_NOTE}.
                </p>
                <p className="text-sm text-ink-soft">ביקשו לקבל עדכון: {formatNumber(waiting[plan.key] ?? 0)}</p>
              </div>
              {canEdit ? (
                <>
                  <PlatformForm action={setPlanAvailabilityAction.bind(null, plan.key)} submitLabel="שמירת המצב">
                    <SelectField label="מצב החבילה" name="availability" defaultValue={plan.availability}>
                      <option value="available">זמינה</option>
                      <option value="coming_soon">בקרוב</option>
                      <option value="hidden">מוסתרת</option>
                    </SelectField>
                  </PlatformForm>
                  <PlatformForm action={updatePlanAction.bind(null, plan.key)} submitLabel="שמירת החבילה">
                    <TextField label="שם" name="name_he" defaultValue={plan.name_he} required maxLength={40} />
                    <div className="grid grid-cols-2 gap-3">
                      <TextField label="מחיר חודשי (₪)" name="price_monthly" inputMode="decimal" dir="ltr" defaultValue={shekels(plan.price_monthly_agorot)} />
                      <TextField label="מחיר שנתי לחודש (₪)" name="price_annual" inputMode="decimal" dir="ltr" defaultValue={shekels(plan.price_annual_agorot)} />
                    </div>
                    <TextareaField label="מגבלות (JSON, null = ללא הגבלה)" name="limits" dir="ltr" rows={5} defaultValue={JSON.stringify(plan.limits, null, 1)} />
                    <TextareaField label="יכולות (JSON)" name="features" dir="ltr" rows={5} defaultValue={JSON.stringify(plan.features, null, 1)} />
                  </PlatformForm>
                </>
              ) : (
                <p className="text-sm text-ink-soft">רק בעלי הפלטפורמה עורכים חבילות.</p>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
