import type { Metadata } from "next";
import { headers } from "next/headers";

import { PublicPageFooter } from "@/features/branding/components/public-page";
import { DigestStopConfirm } from "@/features/digest/components/digest-stop-confirm";
import { DIGEST_STOP_TEXTS } from "@/features/digest/stop";
import { getDigestStopPage } from "@/features/digest/stop-server";
import { isPreviewBotRequest } from "@/features/link-preview/bot-request";
import { clientIp } from "@/lib/keyed-ip-hash";
import { genericPreview } from "@/lib/link-preview";
import { RATE_LIMITED_PAGE_TEXT } from "@/lib/public-rate-limit";
import { guardPublicPage } from "@/lib/public-sender-server";

type Props = { params: Promise<{ token: string }> };

/** Always the generic preview (the metadata never reads the page); not indexed; no Referer. */
export async function generateMetadata(): Promise<Metadata> {
  return { ...genericPreview(DIGEST_STOP_TEXTS.preview, DIGEST_STOP_TEXTS.previewDescription), referrer: "no-referrer" };
}

const MESSAGES = {
  "not-found": DIGEST_STOP_TEXTS.notFound,
  "rate-limited": RATE_LIMITED_PAGE_TEXT,
  "not-configured": DIGEST_STOP_TEXTS.notConfigured,
} as const;

/**
 * USR-11 / WAB-03 (owner (377) ב): the daily summary's stop link, without sign-in. A staff page (our own email to the business's
 * person), so it is not branded with the business's colour. Opening it changes nothing; the button stops the summary.
 */
export default async function DigestStopPage({ params }: Props) {
  const { token } = await params;
  if (await isPreviewBotRequest()) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <p className="text-md text-ink">{DIGEST_STOP_TEXTS.preview}</p>
      </main>
    );
  }
  // OPS-02: the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  const page = await guardPublicPage(async () => getDigestStopPage(token, clientIp(await headers())));

  return (
    <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
      <h1 className="text-2xl font-semibold">{DIGEST_STOP_TEXTS.title}</h1>
      <div className="mt-6">
        {typeof page === "string" ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {MESSAGES[page]}
          </p>
        ) : page.status === "used" ? (
          <p role="status" className="text-md">
            {DIGEST_STOP_TEXTS.used}
          </p>
        ) : (
          <DigestStopConfirm token={token} business={page.business} stopped={page.status === "stopped"} />
        )}
      </div>
      <PublicPageFooter builtWith={false} className="mt-10" />
    </main>
  );
}
