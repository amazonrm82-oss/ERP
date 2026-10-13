import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { businessPlanCanOpen } from "@/features/plans/capabilities";
import { annualPriceLabel, AVAILABILITY_LABELS, monthlyPriceLabel, VAT_NOTE } from "@/features/plans/price";
import { setPlanAvailabilityAction, setTrialEndAction, updatePlanAction } from "@/features/platform/actions";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { getPlanWaitlistCounts, getTrialEndStatus, listPlans, platformReady } from "@/features/platform/queries";
import { formatDate, formatNumber } from "@/lib/format";

export const metadata: Metadata = { title: "חבילות" };

const shekels = (agorot: number) => String(agorot / 100);

export default async function AdminPlansPage() {
  const me = await platformReady();
  if (!me) return null;
  const [plans, waiting, trialEnd] = await Promise.all([listPlans(), getPlanWaitlistCounts(), getTrialEndStatus()]);
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
      {/* BIL-08: off until real billing works end to end (owner, 13 October 2026) */}
      <Card aria-labelledby="trial-end" className="mb-5">
        <CardHeader id="trial-end" title="מעבר בסוף הניסיון" />
        <CardBody className="space-y-3">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={trialEnd.enabled ? "warning" : "neutral"}>{trialEnd.enabled ? "דולק" : "כבוי"}</Badge>
            {trialEnd.enabled && trialEnd.enabledAt ? <span className="text-sm text-ink-soft">מאז {formatDate(trialEnd.enabledAt)}</span> : null}
          </p>
          <p className="text-md text-ink-soft">
            כבוי: עסק שהניסיון שלו נגמר ממשיך לעבוד בחבילה שלו, בלי הודעות. דולק: הוא מקבל 14 יום עם הודעה ותזכורות לבעלים ולמנהלי המערכת,
            אחר כך עובר לקריאה בלבד, ושבוע אחר כך הגישה אליו נסגרת עד לתשלום. אף עסק לא עובר ל&quot;חינם&quot;. עסק ששויך ידנית לחבילה או למצב לא מושפע.
          </p>
          <ul className="space-y-1 text-md">
            <li>ניסיון שנגמר, עוד לא במעבר: {formatNumber(trialEnd.waiting)}</li>
            <li>בתקופת ה-14 יום: {formatNumber(trialEnd.inGrace)}</li>
            <li>בקריאה בלבד: {formatNumber(trialEnd.readOnly)}</li>
            <li>הגישה נסגרה במעבר: {formatNumber(trialEnd.closed)}</li>
            <li>שויכו ידנית ונשארים בלי מעבר: {formatNumber(trialEnd.assigned)}</li>
          </ul>
          {canEdit ? (
            trialEnd.enabled ? (
              <ConfirmButton
                variant="secondary"
                title="לכבות את המעבר בסוף הניסיון?"
                description={`המעבר ייעצר. ${formatNumber(trialEnd.inGrace + trialEnd.readOnly)} עסקים יוצאים ממנו, ומי שהמעבר העביר לקריאה בלבד חוזר לעבוד. עסק שהגישה אליו כבר נסגרה נשאר סגור, ועסק שהצוות קבע לו מצב ידנית נשאר במצב הזה.`}
                confirmLabel="כיבוי"
                action={setTrialEndAction.bind(null, false)}
              >
                כיבוי המעבר
              </ConfirmButton>
            ) : (
              <ConfirmButton
                variant="danger"
                title="להדליק את המעבר בסוף הניסיון?"
                description={`${formatNumber(trialEnd.waiting)} עסקים שהניסיון שלהם נגמר יקבלו 14 יום מהיום, עם הודעה בהרצה היומית הקרובה, ואחר כך יעברו לקריאה בלבד. להדליק רק כשחיוב אמיתי עובד מקצה לקצה.`}
                confirmLabel="הדלקה"
                action={setTrialEndAction.bind(null, true)}
              >
                הדלקת המעבר
              </ConfirmButton>
            )
          ) : (
            <p className="text-sm text-ink-soft">רק בעלי הפלטפורמה מדליקים או מכבים את המעבר.</p>
          )}
        </CardBody>
      </Card>
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
