import type { Metadata } from "next";

import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { MfaGate } from "@/features/auth/components/mfa-gate";
import { requireUser } from "@/lib/auth";
import { safeNextPath } from "@/lib/paths";

export const metadata: Metadata = { title: "אימות דו-שלבי" };

type Props = { searchParams: Promise<{ next?: string | string[] }> };

// The second step after the password, or setting it up when the organization requires it.
export default async function LoginMfaPage({ searchParams }: Props) {
  await requireUser();
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  return (
    <>
      <MfaGate next={next} />
      <div className="mt-4">
        <SignOutButton />
      </div>
    </>
  );
}
