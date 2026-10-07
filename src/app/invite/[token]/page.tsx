import type { Metadata } from "next";
import Link from "next/link";

import { Wordmark } from "@/components/wordmark";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { AcceptInvitationForm } from "@/features/invitations/components/accept-invitation-form";
import { getInvitationPreview } from "@/features/invitations/queries";
import { isInvitationToken } from "@/features/invitations/token";
import { requireAgreement } from "@/features/legal/queries";
import { ROLE_LABELS } from "@/features/shell/labels";
import { requireUser } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "הזמנה להצטרף", referrer: "no-referrer" };

type Props = { params: Promise<{ token: string }> };

// Reached from an invitation link. Signed-out visitors are sent to the login
// page first (src/proxy.ts) and come back here afterwards. Joining needs an
// explicit click, so link previews and prefetching never accept an invitation.
export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  const user = await requireUser();
  await requireAgreement(`/invite/${encodeURIComponent(token)}`);
  const preview = isInvitationToken(token) ? await getInvitationPreview(token) : null;
  const problem = !preview
    ? "הקישור אינו תקין. בדקו שהעתקתם אותו במלואו, או בקשו הזמנה חדשה."
    : preview.alreadyMember
      ? null
      : preview.status === "accepted"
        ? "כבר השתמשו בהזמנה הזו. אם זה לא אתם, בקשו הזמנה חדשה."
        : preview.status === "revoked"
          ? "ההזמנה בוטלה. בקשו ממי שהזמין אתכם הזמנה חדשה."
          : preview.status === "expired"
            ? "תוקף ההזמנה פג. בקשו ממי שהזמין אתכם הזמנה חדשה."
            : null;

  return (
    <div className="min-h-dvh bg-surface">
      <header className="flex items-center justify-between px-5 py-4 sm:px-10">
        <Wordmark className="h-7" />
        <SignOutButton />
      </header>
      <main className="mx-auto w-full max-w-md px-5 pt-6 pb-16 sm:pt-12">
        <h1 className="text-2xl font-semibold">
          {preview?.organizationName ? `הזמנה להצטרף ל${preview.organizationName}` : "הזמנה להצטרף לעסק"}
        </h1>
        {problem || !preview ? (
          <p role="alert" className="mt-4 rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {problem}
          </p>
        ) : preview.alreadyMember ? (
          <p className="mt-4">
            כבר יש לך גישה לעסק הזה.{" "}
            <Link href={paths.home} className="text-accent-strong underline underline-offset-4">
              כניסה לעסק
            </Link>
          </p>
        ) : (
          <>
            <dl className="mt-4 mb-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.9375rem]">
              <dt className="text-ink-soft">תפקיד</dt>
              <dd>{ROLE_LABELS[preview.role] ?? preview.role}</dd>
              {preview.invitedBy ? (
                <>
                  <dt className="text-ink-soft">הוזמנת על ידי</dt>
                  <dd>{preview.invitedBy}</dd>
                </>
              ) : null}
              <dt className="text-ink-soft">בתוקף עד</dt>
              <dd>{formatDate(preview.expiresAt)}</dd>
            </dl>
            {preview.forMe ? (
              <AcceptInvitationForm token={token} />
            ) : (
              <p role="alert" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
                ההזמנה נשלחה לכתובת <span dir="ltr">{preview.emailHint}</span>, ואתם מחוברים עם{" "}
                <span dir="ltr" className="font-medium">
                  {user.email}
                </span>
                . צאו מהחשבון והתחברו, או הירשמו, עם הכתובת שאליה נשלחה ההזמנה, ופתחו שוב את הקישור.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
