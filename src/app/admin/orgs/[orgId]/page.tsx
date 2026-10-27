import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ActionButton } from "@/components/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { openSupportAction, setOrgStatusAction, setOverridesAction, setQrExternalBlockAction, updateSubscriptionAction } from "@/features/platform/actions";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { activationText } from "@/features/platform/activation";
import { ACTION_LABELS, canDo, ORG_STATUS_LABELS } from "@/features/platform/labels";
import { getPlatformOrg, getQrExternalBlock, listPlans, listPlatformLog, platformReady } from "@/features/platform/queries";
import { ROLE_LABELS } from "@/features/shell/labels";
import type { MembershipRole } from "@/lib/database.types";
import { formatDate, formatDateTime, formatNumber, zoneDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { effectiveLimits } from "@/lib/plan-keys";

export const metadata: Metadata = { title: "כרטיס ארגון" };

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

const REASON = <TextField label="סיבה (נרשמת ביומן)" name="reason" required maxLength={500} />;

export default async function AdminOrgPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  const me = await platformReady();
  if (!me) return null;
  const [data, plans, log, qrBlock] = await Promise.all([getPlatformOrg(orgId), listPlans(), listPlatformLog(orgId, 50), getQrExternalBlock(orgId)]);
  if (!data) notFound();

  const org = data.org as Obj;
  const sub = (data.subscription ?? {}) as Obj;
  const plan = (data.plan ?? {}) as Obj;
  const owner = (data.owner ?? {}) as Obj;
  const members = (data.members ?? {}) as Record<string, number>;
  const counts = (data.counts ?? {}) as Obj;
  // the same rule as app.org_limit(), wave 2 defaults included
  const limits = effectiveLimits(plan.limits, sub.limit_overrides) as Obj;
  const supportUntil = str(data.support_until) || null;
  const activation = (data.activation ?? null) as Obj | null;

  return (
    <>
      <PageHeader title={str(org.name)} description={`${ORG_STATUS_LABELS[str(org.status)] ?? str(org.status)} · הצטרף ${formatDate(str(org.created_at))}`} back={{ href: paths.adminOrgs, label: "ארגונים" }} />
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Card aria-labelledby="account">
          <CardHeader id="account" title="חשבון ושימוש" />
          <CardBody>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-md">
              <dt className="text-ink-soft">בעלים</dt>
              <dd>
                {str(owner.name)} <span dir="ltr">{str(owner.email)}</span>
              </dd>
              <dt className="text-ink-soft">חבילה</dt>
              <dd>
                {str(plan.name_he)} ({str(sub.status)}), {sub.seats ? `${formatNumber(Number(sub.seats))} מושבים` : "בלי הגבלת מושבים"}
              </dd>
              <dt className="text-ink-soft">סוף ניסיון</dt>
              <dd>{sub.trial_ends_at ? formatDateTime(str(sub.trial_ends_at)) : "—"}</dd>
              <dt className="text-ink-soft">משתמשים</dt>
              <dd>
                {Object.entries(members)
                  .map(([role, count]) => `${ROLE_LABELS[role as MembershipRole] ?? role}: ${count}`)
                  .join(", ") || "—"}
              </dd>
              <dt className="text-ink-soft">רשומות</dt>
              <dd>
                {formatNumber(Number(data.records ?? 0))} מתוך {limits.max_records == null ? "ללא הגבלה" : formatNumber(Number(limits.max_records))}
              </dd>
              <dt className="text-ink-soft">אוטומציות פעילות</dt>
              <dd>{formatNumber(Number(counts.automations ?? 0))}</dd>
              <dt className="text-ink-soft">טפסים / תהליכי מכירה</dt>
              <dd>
                {formatNumber(Number(counts.forms ?? 0))} / {formatNumber(Number(counts.pipelines ?? 0))}
              </dd>
              <dt className="text-ink-soft">התחיל לעבוד</dt>
              <dd>{activation ? activationText(str(activation.activated_at), str(activation.lead_created_at), str(org.created_at)) : "עדיין לא. אין ליד אמיתי שקיבל מענה בתוך 24 שעות"}</dd>
              <dt className="text-ink-soft">כניסה אחרונה</dt>
              <dd>{data.last_sign_in_at ? formatDateTime(str(data.last_sign_in_at)) : "—"}</dd>
            </dl>
          </CardBody>
        </Card>

        <Card aria-labelledby="support">
          <CardHeader id="support" title="גישת תמיכה" />
          <CardBody className="space-y-3">
            {supportUntil ? (
              <>
                <p>הלקוח אישר גישת תמיכה עד {formatDateTime(supportUntil)}. הכניסה היא לצפייה בלבד, ונרשמת גם ביומן הביקורת של הלקוח.</p>
                {canDo(me.role, ["support"]) ? (
                  <ActionButton action={openSupportAction.bind(null, orgId)} pendingText="נכנסים…" variant="primary">
                    כניסה לארגון (צפייה)
                  </ActionButton>
                ) : (
                  <p className="text-sm text-ink-soft">כניסה מותרת לתפקידי תמיכה ובעלים.</p>
                )}
              </>
            ) : (
              <p className="text-md">הלקוח לא אישר גישת תמיכה. בלי אישור לא רואים את הנתונים שלו. האישור נעשה אצל הלקוח: הגדרות ← פרטי העסק ← גישת תמיכה.</p>
            )}
          </CardBody>
        </Card>

        {canDo(me.role, ["finance"]) ? (
          <Card aria-labelledby="subscription">
            <CardHeader id="subscription" title="חבילה, מושבים וניסיון" />
            <CardBody>
              <PlatformForm action={updateSubscriptionAction.bind(null, orgId)} submitLabel="שמירה">
                <SelectField label="חבילה" name="plan_key" defaultValue={str(sub.plan_key)}>
                  {/* a hidden plan is offered only to the business already on it (migration hide_free_plan) */}
                  {plans.filter((p) => p.is_public || p.key === str(sub.plan_key)).map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name_he}
                    </option>
                  ))}
                </SelectField>
                <TextField label="מושבים" name="seats" type="number" min={1} defaultValue={sub.seats ? String(sub.seats) : ""} hint="ריק: בלי הגבלה" />
                <TextField
                  label="סוף הניסיון"
                  name="trial_ends_on"
                  type="date"
                  defaultValue={sub.trial_ends_at ? zoneDate(new Date(str(sub.trial_ends_at))) : ""}
                  hint="להארכת ניסיון בוחרים תאריך מאוחר יותר"
                />
                {REASON}
              </PlatformForm>
            </CardBody>
          </Card>
        ) : null}

        {me.role === "owner" ? (
          <Card aria-labelledby="status">
            <CardHeader id="status" title="מצב הארגון" />
            <CardBody>
              <PlatformForm action={setOrgStatusAction.bind(null, orgId)} submitLabel="שינוי מצב">
                <SelectField label="מצב" name="status" defaultValue={str(org.status)} hint="מושעה: רק הבעלים נכנס. קריאה בלבד: אי אפשר ליצור או לערוך.">
                  {Object.entries(ORG_STATUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </SelectField>
                {REASON}
              </PlatformForm>
            </CardBody>
          </Card>
        ) : null}

        {me.role === "owner" ? (
          <Card aria-labelledby="overrides" className="lg:col-span-2">
            <CardHeader id="overrides" title="דריסת זכאויות לארגון הזה" />
            <CardBody>
              <PlatformForm action={setOverridesAction.bind(null, orgId)} submitLabel="שמירת דריסות">
                <p className="text-sm text-ink-soft">
                  JSON. מה שכתוב כאן גובר על החבילה. מגבלה: מספר, או null לבלי הגבלה. יכולת: true או false. ריק = אין דריסות. המפתחות כמו בחבילה, למשל
                  <code dir="ltr"> {'{"max_users": 50}'}</code>.
                </p>
                <TextareaField label="מגבלות" name="limits" dir="ltr" rows={3} defaultValue={JSON.stringify(sub.limit_overrides ?? {})} />
                <TextareaField label="יכולות" name="features" dir="ltr" rows={3} defaultValue={JSON.stringify(sub.feature_overrides ?? {})} />
                {REASON}
              </PlatformForm>
            </CardBody>
          </Card>
        ) : null}

        {/* BIZ-03 (owner, 27 October 2026, answer (ה)): the emergency switch for the business's external QR links */}
        <Card aria-labelledby="qr-external">
          <CardHeader id="qr-external" title="קישורים חיצוניים בקודי QR" />
          <CardBody className="space-y-3">
            {qrBlock.blocked ? (
              <p role="status" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
                כבויים{qrBlock.changedAt ? ` מאז ${formatDateTime(qrBlock.changedAt)}` : ""}
                {qrBlock.reason ? `. סיבה: ${qrBlock.reason}` : ""}. מי שסורק קוד שפותח קישור חיצוני רואה שהקוד אינו פעיל.
              </p>
            ) : (
              <p className="text-md">פעילים. קוד שפותח קישור חיצוני מראה קודם דף מעבר עם שם האתר ושם העסק.</p>
            )}
            {canDo(me.role, ["support"]) ? (
              <PlatformForm
                action={setQrExternalBlockAction.bind(null, orgId, !qrBlock.blocked)}
                submitLabel={qrBlock.blocked ? "החזרת הקישורים החיצוניים" : "כיבוי הקישורים החיצוניים"}
              >
                <p className="text-sm text-ink-soft">
                  {qrBlock.blocked
                    ? "הקודים של העסק שפותחים קישור חיצוני יחזרו לעבוד מיד."
                    : "לשימוש לרעה בלבד, למשל הפניה לאתר מתחזה. קודים שפותחים טופס, דף קביעת תור או כרטיס ביקור ממשיכים לעבוד."}
                </p>
                {REASON}
              </PlatformForm>
            ) : (
              <p className="text-sm text-ink-soft">את המתג מפעילים תפקידי תמיכה ובעלים.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card aria-labelledby="org-log" className="mt-5">
        <CardHeader id="org-log" title="פעולות פלטפורמה על הארגון" />
        {log.length === 0 ? (
          <p className="px-4 py-5 text-ink-soft sm:px-5">אין פעולות.</p>
        ) : (
          <ul className="divide-y divide-line">
            {log.map((l) => (
              <li key={String(l.id)} className="px-4 py-3 sm:px-5">
                <p className="font-medium">{ACTION_LABELS[str(l.action)] ?? str(l.action)}</p>
                <p className="text-sm text-ink-soft">
                  {formatDateTime(str(l.created_at))} · <span dir="ltr">{str(l.actor_email)}</span>
                  {str((l.details as Obj)?.reason) ? ` · ${str((l.details as Obj).reason)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
