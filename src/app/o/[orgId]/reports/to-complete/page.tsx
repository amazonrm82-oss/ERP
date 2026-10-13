import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { COMPLETENESS_TYPES, EDIT_PARAM, missingText } from "@/features/data-quality/completeness";
import { completenessSettingsPath } from "@/features/data-quality/paths";
import { listIncomplete } from "@/features/data-quality/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid, paths } from "@/lib/paths";
import { RECORD_TYPES } from "@/lib/record-types";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "רשומות להשלמה" };

const LIMIT = 50;

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const linkClass = "font-medium text-accent underline underline-offset-4 hover:text-accent-strong";

// DQL-01: a person's records whose important fields are not all filled, worst first.
// Everyone sees their own; owners, admins and managers may pick a person (RLS still decides what shows).
export default async function ToCompletePage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const context = await getOrgContext(orgId);
  const canPick = isAdminRole(context.role) || context.role === "manager";
  const members = canPick ? (await listMembers(orgId)).filter((m) => m.status === "active" && m.role !== "viewer") : [];
  const asked = firstParam(query.who);
  const who = canPick && isUuid(asked) && members.some((m) => m.userId === asked) ? asked : context.user.id;
  const mine = who === context.user.id;
  const lists = await Promise.all(COMPLETENESS_TYPES.map((type) => listIncomplete(orgId, type, who, LIMIT)));
  const total = lists.reduce((sum, list) => sum + list.total, 0);

  return (
    <>
      <PageHeader
        title="רשומות להשלמה"
        description="רשומות פתוחות שחסרים בהן שדות חשובים, מהחסרה ביותר."
        back={{ href: paths.reports(orgId), label: "דוחות" }}
      />
      {canPick ? (
        <form method="get" className="mb-5 flex flex-wrap items-end gap-3">
          <SelectField label="של מי" name="who" defaultValue={who} className="w-full sm:w-72">
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.userId === context.user.id ? `${m.name} (אני)` : m.name}
              </option>
            ))}
          </SelectField>
          <Button type="submit" variant="secondary">
            הצגה
          </Button>
        </form>
      ) : null}
      {isAdminRole(context.role) ? (
        <p className="mb-5 text-md text-ink-soft">
          אילו שדות נחשבים חשובים קובעים ב
          <Link href={completenessSettingsPath(orgId)} className={linkClass}>
            הגדרות: שדות חשובים
          </Link>
          .
        </p>
      ) : null}
      {total === 0 ? (
        <Card>
          <CardBody>
            <p className="text-md text-ink-soft">{mine ? "אין לכם רשומות שחסר בהן משהו חשוב. כל הכבוד." : "אין רשומות שחסר בהן משהו חשוב."}</p>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-5">
          {COMPLETENESS_TYPES.map((type, index) => {
            const list = lists[index];
            if (list.total === 0) return null;
            const info = RECORD_TYPES[type];
            const titleId = `to-complete-${type}`;
            return (
              <Card key={type} aria-labelledby={titleId}>
                <CardHeader id={titleId} title={`${info.plural} (${list.total})`} />
                <ul className="divide-y divide-line">
                  {list.rows.map((row) => {
                    const href = info.page ? info.page(orgId, row.id) : info.list(orgId);
                    const first = row.missing.find((m) => m.formField)?.formField;
                    return (
                      <li key={row.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
                        <div className="min-w-0">
                          <Link href={href} className="font-medium text-ink underline-offset-4 hover:underline">
                            {row.name || "ללא שם"}
                          </Link>
                          <p className="text-sm text-ink-soft">{missingText(row.missing.map((m) => m.label))}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <Badge tone={row.score < 50 ? "warning" : "neutral"}>{row.score}%</Badge>
                          {first && context.canWrite ? (
                            <Link href={`${href}?${EDIT_PARAM}=${encodeURIComponent(first)}`} className={`${linkClass} text-sm`}>
                              להשלמה
                            </Link>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {list.total > list.rows.length ? (
                  <CardBody className="border-t border-line">
                    <p className="text-sm text-ink-soft">
                      מוצגות {list.rows.length} מתוך {list.total}. אחרי שתשלימו אותן יופיעו הבאות.
                    </p>
                  </CardBody>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
