import type { Metadata } from "next";
import Link from "next/link";

import { ActionButton } from "@/components/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { signOutOthersAction } from "@/features/account/actions";
import { MfaSettings } from "@/features/account/components/mfa-settings";
import { describeDevice, getRecoveryCodesLeft, listMySessions } from "@/features/account/queries";
import { NewPasswordForm } from "@/features/auth/components/new-password-form";
import { getSignedVersion } from "@/features/legal/queries";
import { NotificationSettingsForm } from "@/features/notifications/components/notification-settings-form";
import { getNotificationSettings } from "@/features/notifications/queries";
import { AvatarPicker } from "@/features/profile/components/avatar-picker";
import { ProfileForm } from "@/features/profile/components/profile-form";
import { getMyProfile } from "@/features/profile/queries";
import { timeZones } from "@/features/profile/working-hours";
import { getOrgContext } from "@/features/shell/queries";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "החשבון שלי" };

export default async function AccountPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { user, org: orgContext } = await getOrgContext(orgId);
  const supabase = await createClient();
  const [profile, sessionsResult, { data: org }, codesLeft, signedVersion, notificationSettings] = await Promise.all([
    getMyProfile(user.id),
    listMySessions(),
    supabase.from("organizations").select("require_mfa").eq("id", orgId).maybeSingle(),
    getRecoveryCodesLeft(),
    getSignedVersion(),
    getNotificationSettings(),
  ]);
  const sessions = sessionsResult.ok ? sessionsResult.sessions : [];

  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <Card aria-labelledby="account-profile" className="lg:col-span-2">
        <CardHeader id="account-profile" title="פרטים אישיים" />
        <CardBody className="space-y-6">
          <AvatarPicker orgId={orgId} userId={user.id} name={profile.fullName} url={profile.avatarUrl} />
          <ProfileForm
            orgId={orgId}
            profile={profile}
            orgTimeZone={orgContext.timeZone}
            timeZones={[...timeZones()].sort()}
          />
        </CardBody>
      </Card>

      <Card aria-labelledby="account-mfa">
        <CardHeader id="account-mfa" title="אימות דו-שלבי" />
        <CardBody>
          <MfaSettings orgRequires={org?.require_mfa === true} codesLeft={codesLeft} />
        </CardBody>
      </Card>

      <Card aria-labelledby="account-password">
        <CardHeader id="account-password" title="שינוי סיסמה" />
        <CardBody>
          <p className="mb-3 text-sm text-ink-soft">
            החשבון: <span dir="ltr">{user.email}</span>
          </p>
          <NewPasswordForm />
        </CardBody>
      </Card>

      <Card aria-labelledby="account-agreement">
        <CardHeader id="account-agreement" title="ההסכם שלכם" />
        <CardBody>
          <p className="text-md">
            {signedVersion ? `חתמת על תנאי השימוש, מדיניות הפרטיות והסכם עיבוד המידע (גרסה ${signedVersion}).` : "עוד לא חתמת על ההסכם."}
          </p>
          <Link href={signedVersion ? paths.agreementSigned : paths.agreement} className="mt-2 inline-block text-accent-strong underline underline-offset-4">
            {signedVersion ? "צפייה בעותק החתום" : "לחתימה"}
          </Link>
        </CardBody>
      </Card>

      <Card aria-labelledby="account-notifications" className="lg:col-span-2">
        <CardHeader id="account-notifications" title="התראות" />
        <CardBody>
          <NotificationSettingsForm orgId={orgId} settings={notificationSettings} />
        </CardBody>
      </Card>

      <Card aria-labelledby="account-sessions" className="lg:col-span-2">
        <CardHeader
          id="account-sessions"
          title="מכשירים מחוברים"
          action={
            sessions.length > 1 ? (
              <ActionButton action={signOutOthersAction.bind(null, orgId)} pendingText="מנתקים…" variant="danger-ghost" confirm="לנתק את כל המכשירים האחרים?">
                ניתוק כל המכשירים האחרים
              </ActionButton>
            ) : null
          }
        />
        <ul className="divide-y divide-line">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
              <span>
                <span className="font-medium">{describeDevice(s.userAgent)}</span>
                {s.isCurrent ? <span className="ms-2 rounded-md bg-accent-soft px-2 py-0.5 text-sm text-accent-strong">המכשיר הזה</span> : null}
              </span>
              <span className="text-sm text-ink-soft">
                פעיל לאחרונה {formatDateTime(s.lastActiveAt)}
                {s.ip ? (
                  <>
                    {" · "}
                    <span dir="ltr">{s.ip}</span>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {!sessionsResult.ok ? (
          <p className="px-4 py-5 text-ink-soft sm:px-5">
            כדי לראות את המכשירים המחוברים צריך להשלים את האימות הדו-שלבי בכניסה הזו.{" "}
            <Link href={`${paths.loginMfa}?next=${encodeURIComponent(paths.settingsAccount(orgId))}`} className="text-accent-strong underline underline-offset-4">
              לאימות
            </Link>
          </p>
        ) : sessions.length === 0 ? (
          <p className="px-4 py-5 text-ink-soft sm:px-5">אין מידע על מכשירים.</p>
        ) : null}
      </Card>
    </div>
  );
}
