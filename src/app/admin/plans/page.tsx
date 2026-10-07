import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextareaField, TextField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { updatePlanAction } from "@/features/platform/actions";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { getPlatformMe, listPlans } from "@/features/platform/queries";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "חבילות" };

const shekels = (agorot: number) => String(agorot / 100);

export default async function AdminPlansPage() {
  const [me, plans] = await Promise.all([getPlatformMe(), listPlans()]);
  const canEdit = me?.role === "owner";

  return (
    <>
      <PageHeader title="חבילות" description="מחירים לפני מע״מ, למושב לחודש. שינוי חל מיד על כל הארגונים בחבילה (חוץ מדריסות לארגון בודד)." />
      <div className="grid items-start gap-5 lg:grid-cols-2">
        {plans.map((plan) => (
          <Card key={plan.key} aria-labelledby={`plan-${plan.key}`}>
            <CardHeader id={`plan-${plan.key}`} title={`${plan.name_he} (${plan.key})`} />
            <CardBody>
              {canEdit ? (
                <PlatformForm action={updatePlanAction.bind(null, plan.key)} submitLabel="שמירת החבילה">
                  <TextField label="שם" name="name_he" defaultValue={plan.name_he} required maxLength={40} />
                  <div className="grid grid-cols-2 gap-3">
                    <TextField label="מחיר חודשי (₪)" name="price_monthly" inputMode="decimal" dir="ltr" defaultValue={shekels(plan.price_monthly_agorot)} />
                    <TextField label="מחיר שנתי לחודש (₪)" name="price_annual" inputMode="decimal" dir="ltr" defaultValue={shekels(plan.price_annual_agorot)} />
                  </div>
                  <TextareaField label="מגבלות (JSON, null = ללא הגבלה)" name="limits" dir="ltr" rows={5} defaultValue={JSON.stringify(plan.limits, null, 1)} />
                  <TextareaField label="יכולות (JSON)" name="features" dir="ltr" rows={5} defaultValue={JSON.stringify(plan.features, null, 1)} />
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="is_public" defaultChecked={plan.is_public} className="size-4 accent-accent" />
                    מוצגת ללקוחות
                  </label>
                </PlatformForm>
              ) : (
                <p>
                  {formatMoney(plan.price_monthly_agorot)} לחודש, {formatMoney(plan.price_annual_agorot)} בתשלום שנתי. רק בעלי הפלטפורמה עורכים חבילות.
                </p>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
