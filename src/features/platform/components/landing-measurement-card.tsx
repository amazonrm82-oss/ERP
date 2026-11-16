import { Card, CardHeader } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";

import { rateText, sourceLabel, summarizeLanding, type LandingCounts, type LandingMeasurement } from "../landing-measurement";

// LND-14: the landing page's counters on the platform dashboard (counts only; no visitor, cookie or address behind them).

const HEADS = ["כניסות", "לחיצות על הרשמה", "הרשמות", "לחיצה מכניסה", "הרשמה מלחיצה", "הרשמה מכניסה"];

function Cells({ c }: { c: LandingCounts }) {
  return (
    <>
      {[formatNumber(c.visits), formatNumber(c.signupClicks), formatNumber(c.signups), rateText(c.signupClicks, c.visits), rateText(c.signups, c.signupClicks), rateText(c.signups, c.visits)].map(
        (value, i) => (
          <td key={HEADS[i]} className="px-4 py-2 tabular-nums">
            {value}
          </td>
        ),
      )}
    </>
  );
}

function Table({ label, first, rows }: { label: string; first: string; rows: Array<{ key: string; name: string; c: LandingCounts }> }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-md">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-line text-sm text-ink-soft">
            {[first, ...HEADS].map((h) => (
              <th key={h} scope="col" className="px-4 py-2 text-start font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="px-4 py-2 text-start font-normal">
                {r.name}
              </th>
              <Cells c={r.c} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const dayText = (day: string) => {
  const [y, m, d] = day.split("-");
  return `${d}.${m}.${y}`;
};

export function LandingMeasurementCard({ data }: { data: LandingMeasurement }) {
  const { total, bySource, byDay } = summarizeLanding(data);
  return (
    <Card aria-labelledby="landing-measurement" className="mt-5">
      <CardHeader id="landing-measurement" title="דף הנחיתה ב-30 הימים האחרונים" />
      <p className="px-4 pt-3 text-sm text-ink-soft sm:px-5">
        ספירות בלבד, בלי עוגיות ובלי מזהה מבקר. המקור הוא utm_source בלבד, ושמות המקורות באים מהקישור שהמבקר הגיע בו, ולכן כל אחד יכול לכתוב שם. הרשמה נספרת כשנוצר חשבון חדש למי שהגיע מכפתור ההרשמה בדף, עוד לפני אימות האימייל, ולכן גם חשבון שלא אומת נספר. מקור מוצג בשמו רק ביום שהיו לו כניסות; אחרת הוא נספר תחת &quot;אחר&quot;.
      </p>
      <dl className="grid gap-3 p-4 sm:grid-cols-3 sm:p-5">
        {[
          ["כניסות", formatNumber(total.visits), null],
          ["לחיצות על הרשמה", formatNumber(total.signupClicks), `${rateText(total.signupClicks, total.visits)} מהכניסות`],
          ["הרשמות", formatNumber(total.signups), `${rateText(total.signups, total.signupClicks)} מהלחיצות · ${rateText(total.signups, total.visits)} מהכניסות`],
        ].map(([label, value, hint]) => (
          <div key={label}>
            <dt className="text-sm text-ink-soft">{label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{value}</dd>
            {hint ? <dd className="text-sm text-ink-soft">{hint}</dd> : null}
          </div>
        ))}
      </dl>
      {bySource.length === 0 ? (
        <p className="px-4 pb-4 text-md text-ink-soft sm:px-5">עוד לא נספרו כניסות.</p>
      ) : (
        <>
          <h3 className="px-4 pt-1 text-md font-semibold sm:px-5">לפי מקור</h3>
          <Table label="דף הנחיתה לפי מקור" first="מקור" rows={bySource.map((s) => ({ key: s.source, name: sourceLabel(s.source), c: s }))} />
          <details className="border-t border-line">
            <summary className="cursor-pointer px-4 py-3 text-md font-semibold sm:px-5">לפי יום</summary>
            <Table label="דף הנחיתה לפי יום" first="יום" rows={byDay.map((d) => ({ key: d.day, name: dayText(d.day), c: d }))} />
          </details>
        </>
      )}
    </Card>
  );
}
