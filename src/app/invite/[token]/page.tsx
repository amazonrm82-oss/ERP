import type { Metadata } from "next";

import { Wordmark } from "@/components/wordmark";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { AcceptInvitationForm } from "@/features/invitations/components/accept-invitation-form";
import { isInvitationToken } from "@/features/invitations/token";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = { title: "הזמנה להצטרף", referrer: "no-referrer" };

type Props = { params: Promise<{ token: string }> };

// Reached from an invitation link. Signed-out visitors are sent to the login
// page first (src/proxy.ts) and come back here afterwards. Joining needs an
// explicit click, so link previews and prefetching never accept an invitation.
export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  const user = await requireUser();
  const valid = isInvitationToken(token);

  return (
    <div className="min-h-dvh bg-surface">
      <header className="flex items-center justify-between px-5 py-4 sm:px-10">
        <Wordmark className="h-7" />
        <SignOutButton />
      </header>
      <main className="mx-auto w-full max-w-md px-5 pt-6 pb-16 sm:pt-12">
        <h1 className="text-2xl font-semibold">הזמנה להצטרף לעסק</h1>
        {valid ? (
          <>
            <p className="mt-1 mb-6 text-ink-soft">
              הוזמנת להצטרף לעסק במערכת. ההזמנה מתאימה רק לכתובת האימייל שאליה נשלחה. החשבון המחובר עכשיו:{" "}
              <span dir="ltr" className="font-medium text-ink">
                {user.email}
              </span>
            </p>
            <AcceptInvitationForm token={token} />
            <p className="mt-6 text-sm text-ink-soft">
              ההזמנה נשלחה לכתובת אחרת? צאו מהחשבון והתחברו, או הירשמו, עם הכתובת שאליה נשלחה ההזמנה, ופתחו שוב את הקישור.
            </p>
          </>
        ) : (
          <p role="alert" className="mt-4 rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
            הקישור אינו תקין. בדקו שהעתקתם אותו במלואו, או בקשו הזמנה חדשה.
          </p>
        )}
      </main>
    </div>
  );
}
