import type { Metadata } from "next";
import { headers } from "next/headers";

import { BrandScope } from "@/features/branding/components/brand-scope";
import { PublicBrandHeader, PublicPageFooter } from "@/features/branding/components/public-page";
import { logoPublicUrl } from "@/features/branding/logo";
import { isPreviewBotRequest } from "@/features/link-preview/bot-request";
import { UnsubscribeConfirm } from "@/features/preferences/components/unsubscribe-confirm";
import { PREFERENCES_MESSAGES, PREFERENCES_TEXTS } from "@/features/preferences/model";
import { getPreferencesPage } from "@/features/preferences/public-server";
import { clientIp } from "@/lib/keyed-ip-hash";
import { genericPreview, PREVIEW_TEXTS } from "@/lib/link-preview";
import { RATE_LIMITED_PAGE_TEXT } from "@/lib/public-rate-limit";
import { guardPublicPage } from "@/lib/public-sender-server";

type Props = { params: Promise<{ token: string }> };

/** CNS-09: always the generic preview (the metadata never reads the page); not indexed; no Referer. */
export async function generateMetadata(): Promise<Metadata> {
  const t = PREVIEW_TEXTS.preferences;
  return { ...genericPreview(t.what, t.description), referrer: "no-referrer" };
}

const MESSAGES = { ...PREFERENCES_MESSAGES, "rate-limited": RATE_LIMITED_PAGE_TEXT } as const;

/**
 * CNS-09 (owner's answer (225) א): the page the unsubscribe link of a message opens. Opening it changes nothing; the button
 * posts the unsubscribe (a mail program's one-click unsubscribe posts to the same route). Never the customer's details.
 */
export default async function PublicUnsubscribePage({ params }: Props) {
  const { token } = await params;
  if (await isPreviewBotRequest()) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <p className="text-md text-ink">{PREVIEW_TEXTS.preferences.what}</p>
      </main>
    );
  }
  // OPS-02 (owner (40) ב, (42) ד): the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  const page = await guardPublicPage(async () => getPreferencesPage(token, clientIp(await headers())));

  if (typeof page === "string") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <h1 className="sr-only">{PREFERENCES_TEXTS.unsubscribeTitle}</h1>
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {MESSAGES[page]}
        </p>
        <PublicPageFooter builtWith={false} />
      </main>
    );
  }

  return (
    // FLD-04 / DSN-17: the business's colour (corrected for contrast) on its own page
    <BrandScope color={page.color}>
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <PublicBrandHeader logoUrl={logoPublicUrl(page.logoPath)} business={page.business} title={PREFERENCES_TEXTS.unsubscribeTitle} subtitle={page.business} />
        <div className="mt-6">
          <UnsubscribeConfirm token={token} channel={page.channel} full={page.full} />
        </div>
        <p className="mt-6 text-sm text-ink-soft">{PREFERENCES_TEXTS.draft}</p>
        <PublicPageFooter builtWith={page.builtWith} />
      </main>
    </BrandScope>
  );
}
