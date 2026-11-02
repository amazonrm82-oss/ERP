import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { canSeeCleanup, cleanupMatchText, CLEANUP_LIST_LIMIT, rareOptionText } from "@/features/data-quality/cleanup";
import { getCleanupSuggestions } from "@/features/data-quality/cleanup-queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { formatDate, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";
import { recordPage, recordTypeNames } from "@/lib/record-types";

export const metadata: Metadata = { title: "הצעות ניקוי" };

type Props = { params: Promise<{ orgId: string }> };

const linkClass = "font-medium text-ink underline-offset-4 hover:underline";
const actionClass = "text-sm font-medium text-accent underline underline-offset-4 hover:text-accent-strong";

function Group({ id, title, total, shown, empty, note, children }: { id: string; title: string; total: number; shown: number; empty: string; note?: string; children: ReactNode }) {
  return (
    <Card aria-labelledby={id}>
      <CardHeader id={id} title={`${title} (${formatNumber(total)})`} />
      {total === 0 ? (
        <CardBody>
          <p className="text-md text-ink-soft">{empty}</p>
        </CardBody>
      ) : (
        <>
          <ul className="divide-y divide-line">{children}</ul>
          {total > shown || note ? (
            <CardBody className="border-t border-line">
              {total > shown ? (
                <p className="text-sm text-ink-soft">
                  מוצגות {formatNumber(shown)} מתוך {formatNumber(total)}. אחרי שתטפלו בהן יופיעו הבאות.
                </p>
              ) : null}
              {note ? <p className="text-sm text-ink-soft">{note}</p> : null}
            </CardBody>
          ) : null}
        </>
      )}
    </Card>
  );
}

// DQL-03: what is worth tidying up, for the people who manage others. RLS decides what each of them sees counted.
export default async function CleanupPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const back = { href: paths.reports(orgId), label: "דוחות" };
  if (!canSeeCleanup(context.role)) {
    return (
      <>
        <PageHeader title="הצעות ניקוי" back={back} />
        <p className="text-md text-ink-soft">הצעות הניקוי מוצגות לבעלים, למנהלי מערכת ולמנהלים.</p>
      </>
    );
  }
  const [read, terms] = await Promise.all([getCleanupSuggestions(orgId), getOrgTerms(orgId)]);
  if (!read.ok) {
    return (
      <>
        <PageHeader title="הצעות ניקוי" back={back} />
        <p role="status" className="text-md text-ink-soft">
          {read.message}
        </p>
      </>
    );
  }
  const answer = read.answer;
  if (!answer.allowed) {
    return (
      <>
        <PageHeader title="הצעות ניקוי" back={back} />
        <p className="text-md text-ink-soft">הצעות הניקוי מוצגות לבעלים, למנהלי מערכת ולמנהלים.</p>
      </>
    );
  }
  const data = answer;
  const names = (type: "lead" | "contact" | "company" | "deal") => recordTypeNames(type, terms);
  const admin = isAdminRole(context.role);
  const leads = names("lead").plural;
  const nameOf = (name: string | null) => name || "ללא שם";

  return (
    <>
      <PageHeader
        title="הצעות ניקוי"
        description={`מה כדאי לסדר: כפילויות חדשות, ${leads} בלי אחראי, רשומות בלי טלפון ובלי אימייל, וערכי בחירה שכמעט לא בשימוש. מוצג רק מה שמותר לכם לראות.`}
        back={back}
      />
      <div className="space-y-5">
        <Group
          id="cleanup-duplicates"
          title="כפילויות חדשות"
          total={data.duplicates.count}
          shown={data.duplicates.items.length}
          empty="לא נמצאו כפילויות ברשומות שנוספו ב-30 הימים האחרונים."
          note="רשומה שנוספה ב-30 הימים האחרונים ויש לפניה רשומה מאותו סוג עם אותו טלפון או אימייל (בחברה: ח.פ., טלפון, אימייל או שם). במיזוג נשארת הרשומה הוותיקה."
        >
          {data.duplicates.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <Link href={recordPage(item.type, orgId, item.id)} className={linkClass}>
                  {nameOf(item.name)}
                </Link>
                <p className="text-sm text-ink-soft">
                  {names(item.type).singular} · נוצר ב-{formatDate(item.created_at)} · {cleanupMatchText(item.match)} כמו{" "}
                  <Link href={recordPage(item.type, orgId, item.other_id)} className="underline underline-offset-4">
                    {nameOf(item.other_name)}
                  </Link>
                </p>
              </div>
              {context.canDelete ? (
                <Link href={paths.merge(orgId, item.type, item.other_id, item.id)} className={actionClass}>
                  למיזוג
                </Link>
              ) : null}
            </li>
          ))}
        </Group>

        <Group
          id="cleanup-unowned"
          title={`${leads} בלי אחראי`}
          total={data.unowned_leads.count}
          shown={data.unowned_leads.items.length}
          empty={`אין ${leads} פתוחים בלי אחראי.`}
          note="מהוותיק לחדש."
        >
          {data.unowned_leads.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
              <Link href={recordPage("lead", orgId, item.id)} className={linkClass}>
                {nameOf(item.name)}
              </Link>
              <span className="text-sm text-ink-soft">{formatDate(item.created_at)}</span>
            </li>
          ))}
        </Group>

        <Group
          id="cleanup-no-channel"
          title="בלי טלפון ובלי אימייל"
          total={data.no_channel.count}
          shown={data.no_channel.items.length}
          empty="לכל הרשומות יש לפחות טלפון או אימייל."
          note={`${names("lead").plural}: ${formatNumber(data.no_channel.leads)} · ${names("contact").plural}: ${formatNumber(data.no_channel.contacts)}. טלפון ואימייל נוספים של איש קשר נחשבים.`}
        >
          {data.no_channel.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
              <Link href={recordPage(item.type, orgId, item.id)} className={linkClass}>
                {nameOf(item.name)}
              </Link>
              <Badge>{names(item.type).singular}</Badge>
            </li>
          ))}
        </Group>

        <Group
          id="cleanup-rare"
          title="ערכי בחירה שכמעט לא בשימוש"
          total={data.rare_options.count}
          shown={data.rare_options.items.length}
          empty={`אין ערכי בחירה שכמעט לא בשימוש (נבדקים שדות בחירה שמלאים לפחות ב-${formatNumber(data.rare_options.min_filled)} רשומות).`}
          note={`ערך שמופיע בפחות משתי רשומות, בשדה בחירה שמלא לפחות ב-${formatNumber(data.rare_options.min_filled)} רשומות. אפשר להסיר אותו או לאחד אותו עם ערך אחר בהגדרות השדות.`}
        >
          {data.rare_options.items.map((item) => (
            <li key={`${item.object_type}:${item.field_key}:${item.option}`} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <p className="font-medium text-ink">
                  {item.field_label}: {item.option}
                </p>
                <p className="text-sm text-ink-soft">
                  {names(item.object_type).plural} · {rareOptionText(item.used, item.filled)}
                </p>
              </div>
              {admin ? (
                <Link href={`${paths.settingsFields(orgId)}?object=${item.object_type}`} className={actionClass}>
                  להגדרות השדה
                </Link>
              ) : null}
            </li>
          ))}
        </Group>
        <p className="text-sm text-ink-soft">
          בכל קבוצה מוצגות עד {formatNumber(CLEANUP_LIST_LIMIT)} רשומות. בעלים ומנהלי מערכת מקבלים פעם בשבוע התראה עם המספרים.
        </p>
      </div>
    </>
  );
}
