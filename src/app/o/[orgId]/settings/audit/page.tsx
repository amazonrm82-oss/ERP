import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { AuditEntries, idsInChanges } from "@/features/audit/components/audit-entries";
import { ENTITY_LABELS, LOGIN_ACTION_LABELS } from "@/features/audit/labels";
import { nameIds } from "@/features/audit/names";
import { listAudit, listLoginEvents } from "@/features/audit/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { cn } from "@/lib/cn";
import { formatDateTime, formatNumber, zonedIso } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "יומן ביקורת" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AuditPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const { role } = await getOrgContext(orgId);
  if (!isAdminRole(role)) notFound();
  const query = await searchParams;
  const tab = firstParam(query.tab) === "logins" ? "logins" : "changes";
  const base = paths.settingsAudit(orgId);

  const tabs = (
    <nav aria-label="סוג היומן" className="mb-4 flex gap-2">
      {[
        { key: "changes", label: "שינויים", href: base },
        { key: "logins", label: "כניסות", href: `${base}?tab=logins` },
      ].map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={tab === t.key ? "page" : undefined}
          className={cn("rounded-md px-3 py-2 text-[0.9375rem]", tab === t.key ? "bg-accent-soft font-semibold text-accent-strong" : "text-ink-soft hover:bg-canvas")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );

  if (tab === "logins") {
    const events = await listLoginEvents(orgId);
    return (
      <>
        {tabs}
        <Card>
          {events.length === 0 ? (
            <p className="px-4 py-6 text-ink-soft sm:px-5">אין כניסות רשומות בתקופה שהחבילה שומרת.</p>
          ) : (
            <ul className="divide-y divide-line">
              {events.map((e, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2 px-4 py-3 sm:px-5">
                  <span>
                    <span className="font-medium">{LOGIN_ACTION_LABELS[e.action] ?? e.action}</span> · {e.userName}
                  </span>
                  <span className="text-sm text-ink-soft">
                    {formatDateTime(e.createdAt)}
                    {e.ip ? (
                      <>
                        {" · "}
                        <span dir="ltr">{e.ip}</span>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </>
    );
  }

  const entityType = firstParam(query.entity) in ENTITY_LABELS ? firstParam(query.entity) : null;
  const actorId = isUuid(firstParam(query.user)) ? firstParam(query.user) : null;
  const fromDate = DATE_RE.test(firstParam(query.from)) ? firstParam(query.from) : "";
  const toDate = DATE_RE.test(firstParam(query.to)) ? firstParam(query.to) : "";
  const page = Math.max(1, Math.min(200, Number(firstParam(query.page)) || 1));
  const [{ items, more, days }, members] = await Promise.all([
    listAudit(orgId, {
      entityType,
      actorId,
      from: fromDate ? zonedIso(fromDate, "00:00:00") : null,
      to: toDate ? zonedIso(toDate, "23:59:59.999") : null,
      page,
    }),
    listMembers(orgId),
  ]);
  const names = await nameIds(orgId, idsInChanges(items));
  const pageHref = (p: number) => {
    const q = new URLSearchParams();
    if (entityType) q.set("entity", entityType);
    if (actorId) q.set("user", actorId);
    if (fromDate) q.set("from", fromDate);
    if (toDate) q.set("to", toDate);
    q.set("page", String(p));
    return `${base}?${q}`;
  };

  return (
    <>
      {tabs}
      <p className="mb-4 text-sm text-ink-soft">
        כל שינוי בנתונים ובהגדרות, מי ומתי, עם הערך הקודם והחדש. אי אפשר לערוך את היומן.{" "}
        {days === null ? "החבילה שומרת את כל היומן." : `החבילה שומרת ${formatNumber(days)} ימים אחורה.`}
      </p>
      <form method="get" className="mb-5 flex flex-wrap items-end gap-3" aria-label="סינון היומן">
        <label>
          <span className="mb-1.5 block text-sm font-medium">סוג</span>
          <Select name="entity" defaultValue={entityType ?? ""} className="w-40">
            <option value="">הכול</option>
            {Object.entries(ENTITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">משתמש</span>
          <Select name="user" defaultValue={actorId ?? ""} className="w-44">
            <option value="">כולם</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">מתאריך</span>
          <Input type="date" name="from" defaultValue={fromDate} className="w-40" />
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">עד תאריך</span>
          <Input type="date" name="to" defaultValue={toDate} className="w-40" />
        </label>
        <button type="submit" className={buttonClasses("secondary", "md")}>
          הצגה
        </button>
      </form>
      <Card>
        {items.length === 0 ? <p className="px-4 py-6 text-ink-soft sm:px-5">אין רשומות ביומן לפי הסינון.</p> : <AuditEntries items={items} names={names} />}
      </Card>
      {page > 1 || more ? (
        <nav aria-label="דפים" className="mt-4 flex items-center gap-2 text-sm">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className={buttonClasses("ghost", "sm")}>
              חדשים יותר
            </Link>
          ) : null}
          {more ? (
            <Link href={pageHref(page + 1)} className={buttonClasses("ghost", "sm")}>
              ישנים יותר
            </Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
