import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { TextLink } from "@/components/ui/text-link";
import { businessPlanCanOpen } from "@/features/plans/capabilities";
import { annualPriceLabel, AVAILABILITY_LABELS, monthlyPriceLabel, VAT_NOTE } from "@/features/plans/price";
import { setPlanAvailabilityAction, setSuspendedLeadNoticesAction, setSuspensionCancelAction, setTrialEndAction, updatePlanAction } from "@/features/platform/actions";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { getPlanWaitlistCounts, getSuspendedLeadNoticesStatus, getSuspensionCancelStatus, getTrialEndStatus, listPlans, platformReady } from "@/features/platform/queries";
import { formatDate, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "חבילות" };

const shekels = (agorot: number) => String(agorot / 100);

export default async function AdminPlansPage() {
  const me = await platformReady();
  if (!me) return null;
  const [plans, waiting, trialEnd, cancel, leadNotices] = await Promise.all([
    listPlans(),
    getPlanWaitlistCounts(),
    getTrialEndStatus(),
    getSuspensionCancelStatus(),
    getSuspendedLeadNoticesStatus(),
  ]);
  const canEdit = me.role === "owner";
  const business = plans.find((plan) => plan.key === "business");

  return (
    <>
      <PageHeader
        title="חבילות"
        description={`מחירים ${VAT_NOTE}, לחודש, לעסק או למשתמש לפי החבילה. שינוי חל מיד על כל הארגונים בחבילה (חוץ מדריסות לארגון בודד).`}
        actions={<TextLink href={paths.adminVat}>שיעורי מע&quot;מ</TextLink>}
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
      {/* BIL-09: 'cancelled' 90 days after suspension, off until the owner decides (13 October 2026) */}
      <Card aria-labelledby="suspension-cancel" className="mb-5">
        <CardHeader id="suspension-cancel" title="ביטול אחרי 90 יום בהשעיה" />
        <CardBody className="space-y-3">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={cancel.enabled ? "warning" : "neutral"}>{cancel.enabled ? "דולק" : "כבוי"}</Badge>
            {cancel.enabled && cancel.enabledAt ? <span className="text-sm text-ink-soft">מאז {formatDate(cancel.enabledAt)}</span> : null}
          </p>
          <p className="text-md text-ink-soft">
            כבוי: עסק מושהה נשאר מושהה. דולק: 90 יום אחרי ההשעיה (ולפחות 30 יום מההודעה הראשונה) המנוי מבוטל, עם הודעות לבעלים 30, 7 ויום
            אחד לפני. שום נתון לא נמחק. אחרי הביטול הטפסים מפסיקים לקלוט לידים, והבעלים עדיין יכול להוריד את הנתונים.
          </p>
          <ul className="space-y-1 text-md">
            <li>עסקים מושהים: {formatNumber(cancel.suspended)}</li>
            <li>עם יום ביטול מתוכנן: {formatNumber(cancel.planned)}</li>
            <li>בוטלו אחרי השעיה: {formatNumber(cancel.cancelled)}</li>
          </ul>
          {canEdit ? (
            cancel.enabled ? (
              <ConfirmButton
                variant="secondary"
                title="לכבות את הביטול אחרי השעיה?"
                description="ימי הביטול המתוכננים מתבטלים, ועסקים מושהים נשארים מושהים. עסק שכבר בוטל נשאר מבוטל."
                confirmLabel="כיבוי"
                action={setSuspensionCancelAction.bind(null, false)}
              >
                כיבוי הביטול
              </ConfirmButton>
            ) : (
              <ConfirmButton
                variant="danger"
                title="להדליק את הביטול אחרי השעיה?"
                description={`${formatNumber(cancel.suspended)} עסקים מושהים יקבלו יום ביטול: 90 יום אחרי ההשעיה, ולפחות 30 יום מהיום, עם הודעות לבעלים לפני כן.`}
                confirmLabel="הדלקה"
                action={setSuspensionCancelAction.bind(null, true)}
              >
                הדלקת הביטול
              </ConfirmButton>
            )
          ) : (
            <p className="text-sm text-ink-soft">רק בעלי הפלטפורמה מדליקים או מכבים את הביטול.</p>
          )}
        </CardBody>
      </Card>
      {/* owner, 13 October 2026: a count of new leads to the owner of a suspended business, off until switched on */}
      <Card aria-labelledby="suspended-lead-notices" className="mb-5">
        <CardHeader id="suspended-lead-notices" title="התראת ליד חדש לעסק מושהה" />
        <CardBody className="space-y-3">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={leadNotices.enabled ? "warning" : "neutral"}>{leadNotices.enabled ? "דולק" : "כבוי"}</Badge>
            {leadNotices.enabled && leadNotices.enabledAt ? <span className="text-sm text-ink-soft">מאז {formatDate(leadNotices.enabledAt)}</span> : null}
          </p>
          <p className="text-md text-ink-soft">
            דולק: הבעלים של עסק מושהה מקבלים התראה על הליד הראשון שנכנס אחרי ההשעיה, ואחר כך לכל היותר אחת ביום עם מספר הלידים. בלי שום
            פרט של הליד. אימייל יתווסף כשתהיה שכבת אימייל.
          </p>
          <p className="text-md">לידים שמחכים להתראה היומית: {formatNumber(leadNotices.waiting)}</p>
          {canEdit ? (
            <ConfirmButton
              variant={leadNotices.enabled ? "secondary" : "danger"}
              title={leadNotices.enabled ? "לכבות את התראות הליד לעסק מושהה?" : "להדליק את התראות הליד לעסק מושהה?"}
              description={leadNotices.enabled ? "לא יישלחו עוד התראות על לידים חדשים לעסקים מושהים." : "מהרגע הזה, ליד שנכנס לעסק מושהה יגרום להתראה לבעלים שלו."}
              confirmLabel={leadNotices.enabled ? "כיבוי" : "הדלקה"}
              action={setSuspendedLeadNoticesAction.bind(null, !leadNotices.enabled)}
            >
              {leadNotices.enabled ? "כיבוי ההתראות" : "הדלקת ההתראות"}
            </ConfirmButton>
          ) : (
            <p className="text-sm text-ink-soft">רק בעלי הפלטפורמה מדליקים או מכבים את ההתראות.</p>
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
