import type { Metadata } from "next";
import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { TextareaField, TextField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { addSubprocessorAction, endSubprocessorAction, removeSubprocessorAction, updateSubprocessorAction } from "@/features/platform/actions";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { listAdminSubprocessors, platformReady, subprocessorAudience } from "@/features/platform/queries";
import {
  addDays,
  ANNOUNCED_FIELDS,
  firstNoticeDay,
  SUBPROCESSOR_NOTICE_DAYS,
  SUBPROCESSOR_STATUS_LABELS,
  subprocessorStatus,
  type AdminSubprocessor,
  type SubprocessorStatus,
} from "@/features/platform/subprocessors";
import { formatDate, zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "קבלני משנה" };

const TONES: Record<SubprocessorStatus, BadgeTone> = { in_force: "success", upcoming: "accent", ended: "neutral", cancelled: "neutral" };

function EntryFields({ entry, minDay, locked }: { entry?: AdminSubprocessor; minDay: string; locked: boolean }) {
  return (
    <>
      <TextField label="שם הספק" name="name" maxLength={120} defaultValue={entry?.name ?? ""} required readOnly={locked} />
      <TextareaField label="תפקיד" name="purpose" maxLength={500} defaultValue={entry?.purpose ?? ""} required readOnly={locked} hint="מה הספק עושה בשירות." />
      <TextareaField label="איזה מידע הוא רואה" name="data_categories" maxLength={500} defaultValue={entry?.dataCategories ?? ""} required readOnly={locked} />
      <TextField label="מיקום" name="location" maxLength={120} defaultValue={entry?.location ?? ""} readOnly={locked && entry?.location !== null} hint="לא חובה. למשל: האיחוד האירופי" />
      <TextField label="אתר" name="website" maxLength={200} dir="ltr" inputMode="url" defaultValue={entry?.website ?? ""} readOnly={locked && entry?.website !== null} hint="לא חובה. מתחיל ב-https://" />
      {locked && entry ? (
        <input type="hidden" name="effective_from" value={entry.effectiveFrom} />
      ) : (
        <DateField
          label="תאריך תחילה"
          name="effective_from"
          defaultValue={entry?.effectiveFrom ?? ""}
          min={minDay}
          required
          hint={`לפחות ${SUBPROCESSOR_NOTICE_DAYS} יום מהיום, כדי שהלקוחות יקבלו הודעה מראש.`}
        />
      )}
    </>
  );
}

// ADM-01 (subprocessors): the list customers see on the public page. Everyone on the platform staff sees it; only the
// platform owner adds, corrects, removes or ends an entry. An entry in force is locked: it is ended from a future day.
export default async function AdminSubprocessorsPage() {
  const me = await platformReady();
  if (!me) return null;
  const today = zoneDate(new Date());
  const entries = await listAdminSubprocessors();
  const canEdit = me.role === "owner";
  const audience = canEdit ? await subprocessorAudience() : 0;
  const audienceLine = `${audience.toLocaleString("he-IL")} בעלי עסקים יקבלו הודעה.`;
  const noticeDay = firstNoticeDay(today);
  const tomorrow = addDays(today, 1);

  return (
    <>
      <PageHeader
        title="קבלני משנה"
        description={`הרשימה שמוצגת ללקוחות בעמוד קבלני המשנה. ספק חדש נכנס לתוקף לפחות ${SUBPROCESSOR_NOTICE_DAYS} יום אחרי שנוסף, וכל בעלי העסקים מקבלים הודעה. ספק שכבר בתוקף נעול: אפשר רק לקבוע לו תאריך סיום.`}
      />
      <p className="mb-5 text-md">
        <Link href={paths.legal("subprocessors")} className="text-accent-strong underline underline-offset-4">
          לעמוד הציבורי
        </Link>
      </p>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card aria-labelledby="sub-list">
          <CardHeader id="sub-list" title="הרשימה" />
          {entries.length === 0 ? (
            <p className="px-4 py-5 text-ink-soft sm:px-5">אין ספקים ברשימה.</p>
          ) : (
            <ul className="divide-y divide-line">
              {entries.map((entry) => {
                const status = subprocessorStatus(entry, today);
                const inForce = status === "in_force";
                const missingDetail = entry.location === null || entry.website === null;
                return (
                  <li key={entry.id} className="space-y-3 px-4 py-3 sm:px-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium break-words">{entry.name}</p>
                        <p className="text-sm text-ink-soft break-words">{entry.purpose}</p>
                        <p className="text-sm text-ink-soft break-words">מידע: {entry.dataCategories}</p>
                        {entry.location ? <p className="text-sm text-ink-soft break-words">מיקום: {entry.location}</p> : null}
                        <p className="text-sm text-ink-soft">
                          מ-{formatDate(entry.effectiveFrom)}
                          {entry.endsOn ? ` עד ${formatDate(addDays(entry.endsOn, -1))}` : ""}
                        </p>
                      </div>
                      <Badge tone={TONES[status]}>{SUBPROCESSOR_STATUS_LABELS[status]}</Badge>
                    </div>
                    {canEdit && (status === "upcoming" || inForce) ? (
                      <div className="flex flex-wrap items-start gap-2">
                        {status === "upcoming" || missingDetail ? (
                          <details className="min-w-0 basis-full">
                            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent-strong">
                              {status === "upcoming" ? "תיקון" : "השלמת מיקום או אתר"}
                            </summary>
                            {status === "upcoming" ? (
                              <p className="mt-2 text-sm text-ink-soft">
                                שינוי בשם, בתאריך, בתפקיד או במידע שולח לבעלי העסקים הודעה חדשה, ודורש שהתאריך יהיה לפחות {SUBPROCESSOR_NOTICE_DAYS} יום מהיום.
                              </p>
                            ) : null}
                            <PlatformForm
                              action={updateSubprocessorAction.bind(null, entry.id)}
                              submitLabel="שמירה"
                              className="mt-2 space-y-4"
                              announce={
                                status === "upcoming"
                                  ? {
                                      audience,
                                      baseline: { name: entry.name, purpose: entry.purpose, data_categories: entry.dataCategories, effective_from: entry.effectiveFrom },
                                      fields: ANNOUNCED_FIELDS,
                                      title: `לשמור את השינוי ב-${entry.name} ולשלוח הודעה?`,
                                      confirmLabel: "שמירה ושליחה",
                                    }
                                  : undefined
                              }
                            >
                              <EntryFields entry={entry} minDay={noticeDay} locked={inForce} />
                            </PlatformForm>
                          </details>
                        ) : null}
                        <details className="min-w-0 basis-full">
                          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent-strong">תאריך סיום</summary>
                          <PlatformForm
                            action={endSubprocessorAction.bind(null, entry.id)}
                            submitLabel="שמירה"
                            className="mt-2 space-y-4"
                            announce={{
                              audience,
                              baseline: { ends_on: entry.endsOn ?? "" },
                              fields: ["ends_on"],
                              title: `לשנות את תאריך הסיום של ${entry.name} ולשלוח הודעה?`,
                              confirmLabel: "שמירה ושליחה",
                            }}
                          >
                            <DateField
                              label="היום הראשון שבו הספק כבר לא ברשימה"
                              name="ends_on"
                              defaultValue={entry.endsOn ?? ""}
                              min={tomorrow}
                              hint={`רק תאריך עתידי. השאירו ריק כדי לבטל סיום שנקבע. כל שינוי נשלח בהודעה לבעלי העסקים${status === "upcoming" ? `, ודורש שהספק ייכנס לתוקף לפחות ${SUBPROCESSOR_NOTICE_DAYS} יום מהיום` : ""}.`}
                            />
                          </PlatformForm>
                        </details>
                        {status === "upcoming" ? (
                          <ConfirmButton
                            title={`להסיר את ${entry.name}?`}
                            description={`הספק עוד לא נכנס לתוקף, ולכן אפשר להסיר אותו. בעלי העסקים יקבלו הודעה שהוא לא יצטרף: ${audienceLine} הפעולה נרשמת ביומן.`}
                            confirmLabel="הסרה"
                            action={removeSubprocessorAction.bind(null, entry.id)}
                          >
                            הסרה
                          </ConfirmButton>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        {canEdit ? (
          <Card aria-labelledby="sub-add">
            <CardHeader id="sub-add" title="ספק חדש" />
            <CardBody>
              <PlatformForm
                action={addSubprocessorAction}
                submitLabel="הוספה ושליחת הודעה"
                announce={{ audience, always: true, title: "להוסיף את הספק ולשלוח הודעה?", confirmLabel: "הוספה ושליחה" }}
              >
                <EntryFields minDay={noticeDay} locked={false} />
              </PlatformForm>
              <p className="mt-3 text-sm text-ink-soft">כל בעלי העסקים יקבלו הודעה עם שם הספק והתאריך. נוסח ההודעה זמני, עד שעורך הדין יבדוק אותו.</p>
            </CardBody>
          </Card>
        ) : (
          <p className="text-md text-ink-soft">רק בעלי הפלטפורמה מוסיפים, מתקנים או מסיימים ספקים.</p>
        )}
      </div>
    </>
  );
}
