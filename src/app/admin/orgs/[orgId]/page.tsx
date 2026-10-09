import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ActionButton } from "@/components/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { openSupportAction, setOrgStatusAction, setOverridesAction, updateSubscriptionAction } from "@/features/platform/actions";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { ACTION_LABELS, canDo, ORG_STATUS_LABELS } from "@/features/platform/labels";
import { getPlatformOrg, listPlans, listPlatformLog, platformReady } from "@/features/platform/queries";
import { ROLE_LABELS } from "@/features/shell/labels";
import type { MembershipRole } from "@/lib/database.types";
import { formatDate, formatDateTime, formatNumber, zoneDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "כרטיס ארגון" };

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

const REASON = <TextField label="סיבה (נרשמת ביומן)" name="reason" required maxLength={500} />;

export default async function AdminOrgPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  const me = await platformReady();
  if (!me) return null;
  const [data, plans, log] = await Promise.all([getPlatformOrg(orgId), listPlans(), listPlatformLog(orgId, 50)]);
  if (!data) notFound();

  const org = data.org as Obj;
  const sub = (data.subscription ?? {}) as Obj;
  const plan = (data.plan ?? {}) as Obj;
  const owner = (data.owner ?? {}) as Obj;
  const members = (data.members ?? {}) as Record<string, number>;
  const counts = (data.counts ?? {}) as Obj;
  const limits = { ...((plan.limits ?? {}) as Obj), ...((sub.limit_overrides ?? {}) as Obj) };
  const supportUntil = str(data.support_until) || null;

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
              <dt className="text-ink-soft">טפסים / פייפליינים</dt>
              <dd>
                {formatNumber(Number(counts.forms ?? 0))} / {formatNumber(Number(counts.pipelines ?? 0))}
              </dd>
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
                  {plans.map((p) => (
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
