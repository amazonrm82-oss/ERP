import type { Metadata } from "next";
import { headers } from "next/headers";

import { buttonClasses } from "@/components/ui/button";
import { BrandScope } from "@/features/branding/components/brand-scope";
import { PublicBrandHeader, PublicPageFooter } from "@/features/branding/components/public-page";
import { logoPublicUrl } from "@/features/branding/logo";
import { formatBytes } from "@/features/files/types";
import { LIBRARY_PAGE_TEXTS } from "@/features/library-links/texts";
import { linkHost, publicLibraryFilePath, publicLibraryGoPath } from "@/features/library-links/public";
import { getPublicLibraryItem, LIBRARY_MESSAGES } from "@/features/library-links/public-server";
import { isPreviewBotRequest } from "@/features/link-preview/bot-request";
import { clientIp } from "@/lib/keyed-ip-hash";
import { genericPreview, PREVIEW_TEXTS } from "@/lib/link-preview";
import { guardPublicPage } from "@/lib/public-sender-server";

type Props = { params: Promise<{ token: string }> };

/**
 * WAB-05 for LIB-02: the link's preview is always the generic one, for people and bots alike, so the metadata never reads the
 * page (a read counts a view and tells the rep) and never names the business or the item. Not for search engines, and the
 * secret address never leaves in a Referer header.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = PREVIEW_TEXTS.library;
  return { ...genericPreview(t.what, t.description), referrer: "no-referrer" };
}

/**
 * LIB-02: a library item (a catalog, price list, presentation, video) a rep sent by a personal link: no sign-in and no
 * cookies; the business's name and brand, and the item's title, description and its link or file. Opening it counts a view,
 * writes one timeline entry a day and tells the rep on the first opening (owner (292) ב).
 */
export default async function PublicLibraryPage({ params }: Props) {
  const { token } = await params;
  // a listed preview bot gets one line, and the page is never read for it (no view counted, no notice)
  if (await isPreviewBotRequest()) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <p className="text-md text-ink">{PREVIEW_TEXTS.library.what}</p>
      </main>
    );
  }
  // OPS-02: the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  const page = await guardPublicPage(async () => getPublicLibraryItem(token, clientIp(await headers())));

  if (typeof page === "string") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <h1 className="sr-only">{LIBRARY_PAGE_TEXTS.title}</h1>
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {LIBRARY_MESSAGES[page]}
        </p>
        <PublicPageFooter builtWith={false} />
      </main>
    );
  }

  const host = page.url ? linkHost(page.url) : null;
  return (
    // FLD-04 / DSN-17: the business's colour (corrected for contrast) on its own page
    <BrandScope color={page.color}>
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <PublicBrandHeader logoUrl={logoPublicUrl(page.logoPath)} business={page.business} title={page.title} subtitle={page.business} />
        <div className="mt-6 space-y-4">
          {page.description ? <p className="text-md whitespace-pre-line break-words">{page.description}</p> : null}
          {page.kind === "link" && page.url ? (
            <div className="space-y-2">
              {/* owner (293) ב: never straight to the site; first the page that names it and the business (BIZ-03's page) */}
              <a href={publicLibraryGoPath(token)} rel="nofollow noreferrer" referrerPolicy="no-referrer" className={buttonClasses("primary", "md")}>
                {LIBRARY_PAGE_TEXTS.openLink}
              </a>
              {host ? (
                <p className="text-sm text-ink-soft">
                  {LIBRARY_PAGE_TEXTS.opensSite} <bdi dir="ltr">{host}</bdi>
                </p>
              ) : null}
            </div>
          ) : null}
          {page.kind === "link" && page.externalBlocked ? <p className="text-sm text-ink-soft">{LIBRARY_PAGE_TEXTS.linkOff}</p> : null}
          {page.kind === "file" && page.file ? (
            <div className="space-y-2">
              <a href={publicLibraryFilePath(token)} rel="nofollow" className={buttonClasses("primary", "md")}>
                {LIBRARY_PAGE_TEXTS.openFile}
              </a>
              <p className="text-sm text-ink-soft break-words">
                <bdi>{page.file.name}</bdi> · <span dir="ltr">{formatBytes(page.file.sizeBytes)}</span>
              </p>
            </div>
          ) : null}
        </div>
        <PublicPageFooter builtWith={page.builtWith} className="mt-10" />
      </main>
    </BrandScope>
  );
}
