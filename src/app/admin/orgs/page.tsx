import type { Metadata } from "next";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { ORG_STATUS_LABELS } from "@/features/platform/labels";
import { listPlans, listPlatformOrgs, ORGS_PAGE_SIZE, platformReady } from "@/features/platform/queries";
import { formatDate, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "ארגונים" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AdminOrgsPage({ searchParams }: Props) {
  if (!(await platformReady())) return null;
  const params = await searchParams;
  const search = firstParam(params.q).trim().slice(0, 100) || null;
  const status = firstParam(params.status) in ORG_STATUS_LABELS ? firstParam(params.status) : null;
  const plans = await listPlans();
  const plan = plans.some((p) => p.key === firstParam(params.plan)) ? firstParam(params.plan) : null;
  const page = Math.max(1, Math.min(1000, Number(firstParam(params.page)) || 1));
  const { total, rows } = await listPlatformOrgs({ search, status, plan, page });
  const pages = Math.max(1, Math.ceil(total / ORGS_PAGE_SIZE));
  const pageHref = (p: number) => {
    const q = new URLSearchParams();
    if (search) q.set("q", search);
    if (status) q.set("status", status);
    if (plan) q.set("plan", plan);
    q.set("page", String(p));
    return `${paths.adminOrgs}?${q}`;
  };

  return (
    <>
      <PageHeader title="ארגונים" description={`${formatNumber(total)} ארגונים`} />
      <form method="get" className="mb-5 flex flex-wrap items-end gap-3" aria-label="חיפוש ארגונים">
        <label className="min-w-56 flex-1">
          <span className="mb-1.5 block text-sm font-medium">חיפוש</span>
          <Input name="q" defaultValue={search ?? ""} placeholder="שם, כתובת או אימייל של הבעלים" />
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">מצב</span>
          <Select name="status" defaultValue={status ?? ""} className="w-40">
            <option value="">הכול</option>
            {Object.entries(ORG_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">חבילה</span>
          <Select name="plan" defaultValue={plan ?? ""} className="w-40">
            <option value="">הכול</option>
            {plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name_he}
              </option>
            ))}
          </Select>
        </label>
        <button type="submit" className={buttonClasses("secondary", "md")}>
          חיפוש
        </button>
      </form>
      <div role="region" aria-label="ארגונים" tabIndex={0} className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[50rem] text-md">
          <thead>
            <tr className="border-b border-line text-sm text-ink-soft">
              {["ארגון", "בעלים", "מצב", "חבילה", "משתמשים", "רשומות", "הצטרף", "התחיל לעבוד"].map((h) => (
                <th key={h} scope="col" className="px-4 py-2.5 text-start font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <th scope="row" className="px-4 py-2.5 text-start font-normal">
                  <Link href={paths.adminOrg(String(r.id))} className="font-medium underline underline-offset-4 hover:text-accent-strong">
                    {String(r.name)}
                  </Link>
                </th>
                <td className="px-4 py-2.5" dir="ltr">
                  <span className="block text-end">{String(r.owner_email ?? "")}</span>
                </td>
                <td className="px-4 py-2.5">{ORG_STATUS_LABELS[String(r.status)] ?? String(r.status)}</td>
                <td className="px-4 py-2.5">{plans.find((p) => p.key === r.plan_key)?.name_he ?? String(r.plan_key ?? "")}</td>
                <td className="px-4 py-2.5 tabular-nums">{formatNumber(Number(r.members ?? 0))}</td>
                <td className="px-4 py-2.5 tabular-nums">{formatNumber(Number(r.records ?? 0))}</td>
                <td className="px-4 py-2.5">{formatDate(String(r.created_at))}</td>
                <td className="px-4 py-2.5">{r.activated_at ? formatDate(String(r.activated_at)) : "עדיין לא"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="px-4 py-6 text-ink-soft">לא נמצאו ארגונים.</p> : null}
      </div>
      {pages > 1 ? (
        <nav aria-label="דפים" className="mt-4 flex items-center gap-2 text-sm">
          {page > 1 ? <Link href={pageHref(page - 1)} className={buttonClasses("ghost", "sm")}>הקודם</Link> : null}
          <span>
            דף {formatNumber(page)} מתוך {formatNumber(pages)}
          </span>
          {page < pages ? <Link href={pageHref(page + 1)} className={buttonClasses("ghost", "sm")}>הבא</Link> : null}
        </nav>
      ) : null}
    </>
  );
}
