import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ORG_STATUS_LABELS } from "@/features/platform/labels";
import { getPlatformMetrics } from "@/features/platform/queries";
import { formatMoney, formatNumber } from "@/lib/format";

type Obj = Record<string, unknown>;
const n = (value: unknown) => Number(value ?? 0) || 0;

export default async function AdminHomePage() {
  const m = await getPlatformMetrics();
  const conversion = (m.trial_conversion ?? {}) as Obj;
  const health = (m.health ?? {}) as Obj;
  const ended = n(conversion.ended);
  const tiles = [
    { label: "הכנסה חודשית חוזרת (MRR)", value: formatMoney(n(m.mrr_agorot)), hint: "לפני מע\"מ, חבילות בתשלום במצב פעיל" },
    { label: "ארגונים משלמים", value: formatNumber(n(m.paying_orgs)), hint: m.arpa_agorot ? `הכנסה ממוצעת לארגון: ${formatMoney(n(m.arpa_agorot))}` : undefined },
    { label: "המרה מניסיון לתשלום", value: ended ? `${Math.round((n(conversion.paying) / ended) * 100)}%` : "—", hint: `${formatNumber(n(conversion.paying))} מתוך ${formatNumber(ended)} שהניסיון שלהם נגמר` },
    { label: "ארגונים", value: formatNumber(n(m.orgs_total)), hint: `${formatNumber(n(m.cancelled_30d))} בוטלו ב-30 הימים האחרונים` },
    { label: "משתמשים פעילים", value: `${formatNumber(n(m.active_users_1d))} ביום · ${formatNumber(n(m.active_users_30d))} בחודש`, hint: `${formatNumber(n(m.users_total))} משתמשים רשומים` },
    { label: "ארגונים בסיכון נטישה", value: formatNumber(n(m.quiet_orgs)), hint: "אף משתמש לא נכנס 14 יום" },
  ];
  const byStatus = (m.by_status ?? {}) as Obj;
  const byPlan = (m.by_plan ?? {}) as Obj;
  const newByMonth = (m.new_by_month ?? []) as Array<{ month: string; n: number }>;
  const maxNew = Math.max(1, ...newByMonth.map((r) => n(r.n)));

  return (
    <>
      <PageHeader title="מדדים" description="נתוני חשבון ושימוש בלבד. נתוני לקוחות לא מוצגים כאן." />
      <dl className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-line bg-surface p-4">
            <dt className="text-sm text-ink-soft">{t.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</dd>
            {t.hint ? <dd className="mt-0.5 text-sm text-ink-soft">{t.hint}</dd> : null}
          </div>
        ))}
      </dl>
      <div className="grid items-start gap-5 lg:grid-cols-3">
        <Card aria-labelledby="by-status">
          <CardHeader id="by-status" title="לפי מצב" />
          <ul className="divide-y divide-line">
            {Object.entries(byStatus).map(([status, count]) => (
              <li key={status} className="flex justify-between px-4 py-2.5 sm:px-5">
                <span>{ORG_STATUS_LABELS[status] ?? status}</span>
                <span className="tabular-nums">{formatNumber(n(count))}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card aria-labelledby="by-plan">
          <CardHeader id="by-plan" title="לפי חבילה" />
          <ul className="divide-y divide-line">
            {Object.entries(byPlan).map(([plan, count]) => (
              <li key={plan} className="flex justify-between px-4 py-2.5 sm:px-5">
                <span dir="ltr">{plan}</span>
                <span className="tabular-nums">{formatNumber(n(count))}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card aria-labelledby="new-orgs">
          <CardHeader id="new-orgs" title="ארגונים חדשים לפי חודש" />
          <ul className="space-y-2 px-4 py-3 sm:px-5">
            {newByMonth.map((r) => (
              <li key={r.month} className="text-sm">
                <span className="flex justify-between">
                  <span dir="ltr">{r.month}</span>
                  <span className="tabular-nums">{formatNumber(n(r.n))}</span>
                </span>
                <span aria-hidden="true" className="mt-1 block h-1.5 rounded-full bg-canvas">
                  <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${(n(r.n) / maxNew) * 100}%` }} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card aria-labelledby="health" className="mt-5">
        <CardHeader id="health" title="בריאות המערכת" />
        <dl className="grid gap-3 p-4 sm:grid-cols-3 sm:p-5">
          {[
            ["אירועים שמחכים למנוע האוטומציות", health.outbox_backlog],
            ["הרצות אוטומציה שנכשלו ב-24 שעות", health.automation_failures_24h],
            ["התראות שמחכות לדחיפה לנייד", health.push_pending],
          ].map(([label, value]) => (
            <div key={label as string}>
              <dt className="text-sm text-ink-soft">{label as string}</dt>
              <dd className="text-xl font-semibold tabular-nums">{formatNumber(n(value))}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}
