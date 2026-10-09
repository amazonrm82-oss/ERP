import type { Metadata } from "next";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Label, SelectField, TextField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { platformResetMfaAction } from "@/features/platform/actions";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { canDo, IDENTITY_CHECKS } from "@/features/platform/labels";
import { findPlatformUser, platformReady } from "@/features/platform/queries";
import { ROLE_LABELS } from "@/features/shell/labels";
import type { MembershipRole } from "@/lib/database.types";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "משתמשים" };

type Props = { searchParams: Promise<{ email?: string | string[] }> };
type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

export default async function AdminUsersPage({ searchParams }: Props) {
  const me = await platformReady();
  if (!me) return null;
  const raw = (await searchParams).email;
  const email = (typeof raw === "string" ? raw : "").trim();
  const user = email ? await findPlatformUser(email) : null;
  const orgs = (Array.isArray(user?.orgs) ? user.orgs : []) as Obj[];

  return (
    <>
      <PageHeader title="משתמשים" description="חיפוש משתמש לפי אימייל, ואיפוס אימות דו-שלבי למי שאיבד גם את הטלפון וגם את קודי הגיבוי." />

      <form action={paths.adminUsers} className="mb-6 flex max-w-xl flex-wrap items-end gap-2">
        <div className="min-w-60 flex-1">
          <Label htmlFor="user-email">אימייל</Label>
          <input
            id="user-email"
            name="email"
            type="email"
            dir="ltr"
            defaultValue={email}
            required
            className="block min-h-11 w-full rounded-md border border-line-control bg-surface px-3 text-end"
          />
        </div>
        <Button type="submit">חיפוש</Button>
      </form>

      {email && !user ? <p>אין משתמש עם האימייל הזה.</p> : null}

      {user ? (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <Card aria-labelledby="user-details">
            <CardHeader id="user-details" title={str(user.name) || str(user.email)} />
            <CardBody>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-md">
                <dt className="text-ink-soft">אימייל</dt>
                <dd dir="ltr" className="text-end">{str(user.email)}</dd>
                <dt className="text-ink-soft">נרשם</dt>
                <dd>{formatDateTime(str(user.created_at))}</dd>
                <dt className="text-ink-soft">כניסה אחרונה</dt>
                <dd>{user.last_sign_in_at ? formatDateTime(str(user.last_sign_in_at)) : "—"}</dd>
                <dt className="text-ink-soft">אימות דו-שלבי</dt>
                <dd>{user.mfa ? `פעיל, ${Number(user.codes_left ?? 0)} קודי גיבוי נשארו` : "כבוי"}</dd>
                <dt className="text-ink-soft">הסכם</dt>
                <dd>{user.signed_version ? `חתום, גרסה ${str(user.signed_version)}` : "לא חתם"}</dd>
              </dl>
              <h3 className="mt-5 mb-2 font-semibold">עסקים</h3>
              {orgs.length === 0 ? (
                <p className="text-ink-soft">לא שייך לאף עסק.</p>
              ) : (
                <ul className="space-y-2">
                  {orgs.map((o) => (
                    <li key={str(o.id)} className="text-md">
                      <a href={paths.adminOrg(str(o.id))} className="font-medium text-accent-strong underline underline-offset-4">
                        {str(o.name)}
                      </a>{" "}
                      · {ROLE_LABELS[o.role as MembershipRole] ?? str(o.role)}
                      {o.status !== "active" ? " (מושבת)" : ""}
                      {o.require_mfa ? " · העסק מחייב אימות" : ""}
                      <br />
                      <span className="text-sm text-ink-soft">
                        בעלים: <span dir="ltr">{str(o.owner_email)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card aria-labelledby="mfa-reset">
            <CardHeader id="mfa-reset" title="איפוס אימות דו-שלבי" />
            <CardBody className="space-y-4">
              <div className="text-md">
                <p className="font-semibold">לפני איפוס, מוודאים שהפונה הוא בעל החשבון:</p>
                <ol className="mt-1 list-decimal space-y-1 ps-5">
                  <li>משתמש בעסק עם מנהל: מבקשים מהבעלים או ממנהל מערכת בעסק לאשר בכתב, אחרי שדיבר איתו. אם המשתמש שייך רק לעסק אחד, המנהל יכול גם לאפס בעצמו בהגדרות ← משתמשים.</li>
                  <li>בעלים של עסק, או מי שאין לו מנהל: עונים רק לאימייל של החשבון, ושואלים פרטים שרק הוא יודע (שם העסק, טלפון העסק, ליד שנוצר לאחרונה). בספק: שיחת וידאו עם תעודה מזהה.</li>
                  <li>לא מאפסים בגלל לחץ או דחיפות, ולא לפי פנייה מטלפון או מאימייל אחר.</li>
                  <li>אחרי האיפוס המשתמש מנותק מכל המכשירים, והבעלים ומנהלי המערכת של העסקים שלו מקבלים התראה.</li>
                </ol>
              </div>
              {!user.mfa ? (
                <p className="text-ink-soft">אימות דו-שלבי כבוי אצל המשתמש. אין מה לאפס. אם שכח סיסמה, הוא מאפס אותה לבד ב&quot;שכחתי סיסמה&quot;.</p>
              ) : canDo(me.role, ["support"]) ? (
                <PlatformForm action={platformResetMfaAction.bind(null, str(user.id))} submitLabel="איפוס אימות דו-שלבי">
                  <SelectField label="איך זוהה המשתמש" name="check" required defaultValue="">
                    <option value="" disabled>
                      בחירה
                    </option>
                    {Object.entries(IDENTITY_CHECKS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </SelectField>
                  <TextField label="פרטים (נרשמים ביומן)" name="reason" required maxLength={500} hint="למשל: מי אישר, מתי ובאיזה ערוץ" />
                  <label className="flex items-start gap-2 text-md">
                    <input type="checkbox" name="confirm" className="mt-1 size-4" required />
                    בדקתי את זהות הפונה לפי הנוהל
                  </label>
                </PlatformForm>
              ) : (
                <p className="text-sm text-ink-soft">איפוס מותר לתפקידי תמיכה ובעלים.</p>
              )}
            </CardBody>
          </Card>
        </div>
      ) : null}
    </>
  );
}
