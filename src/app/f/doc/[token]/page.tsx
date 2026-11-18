import "@/features/print/print.css";

import type { Metadata } from "next";
import { headers } from "next/headers";

import { buttonClasses } from "@/components/ui/button";
import { BrandScope } from "@/features/branding/components/brand-scope";
import { PublicBrandHeader, PublicPageFooter } from "@/features/branding/components/public-page";
import { logoPublicUrl } from "@/features/branding/logo";
import { DocumentView } from "@/features/document-links/components/document-view";
import { publicDocumentFilePath } from "@/features/document-links/public";
import { DOCUMENT_MESSAGES, getPublicDocument } from "@/features/document-links/public-server";
import { isPreviewBotRequest } from "@/features/link-preview/bot-request";
import { PrintButton } from "@/features/print/components/print-button";
import { clientIp } from "@/lib/keyed-ip-hash";
import { genericPreview, PREVIEW_TEXTS } from "@/lib/link-preview";
import { guardPublicPage } from "@/lib/public-sender-server";

type Props = { params: Promise<{ token: string }> };

/**
 * WAB-05 for DOC-15: the link's preview is always the generic one, for people and bots alike, so the metadata never reads the
 * page (no view is counted for it) and never names the business or the customer. Not for search engines, and the secret
 * address never leaves in a Referer header.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = PREVIEW_TEXTS.document;
  return { ...genericPreview(t.what, t.description), referrer: "no-referrer" };
}

/**
 * DOC-15 (owner (414) א): the customer's page of one accounting document through its secret link: no sign-in and no cookies;
 * the business's name and brand, the document's type, number, dates, lines, totals and pay state, and its PDF while it has
 * one. A cancelled document answers its type and number only. Printable (GAP-11's print rules).
 */
export default async function PublicDocumentPage({ params }: Props) {
  const { token } = await params;
  // a listed preview bot gets one line, and the document is never read for it (no view counted)
  if (await isPreviewBotRequest()) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <p className="text-md text-ink">{PREVIEW_TEXTS.document.what}</p>
      </main>
    );
  }
  // OPS-02: the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  const page = await guardPublicPage(async () => getPublicDocument(token, clientIp(await headers())));

  if (typeof page === "string") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <h1 className="sr-only">מסמך</h1>
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {DOCUMENT_MESSAGES[page]}
        </p>
        <PublicPageFooter builtWith={false} />
      </main>
    );
  }

  return (
    // DSN-17: the whole page in the business's colour, corrected for contrast
    <BrandScope color={page.color}>
      <main className="mx-auto min-h-dvh w-full max-w-3xl space-y-5 px-4 py-6 sm:px-6 sm:py-10">
        <PublicBrandHeader
          logoUrl={logoPublicUrl(page.logoPath)}
          business={page.displayName}
          nameShown={page.business === page.displayName}
          title={page.title}
          subtitle={page.business}
        />
        {page.kind === "cancelled" ? (
          <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
            המסמך הזה בוטל. לפרטים פנו לעסק ששלח אותו.
          </p>
        ) : (
          <>
            {/* data-print-page: print.css leaves only the document on paper */}
            <div data-print-page="" className="flex flex-wrap justify-end gap-2 print:hidden">
              {page.hasFile ? (
                <a href={publicDocumentFilePath(token)} rel="nofollow" className={buttonClasses("secondary", "sm")}>
                  הורדת PDF
                </a>
              ) : null}
              <PrintButton label="הדפסה" />
            </div>
            <DocumentView doc={page} />
          </>
        )}
        <PublicPageFooter builtWith={page.builtWith} className="print:hidden" />
      </main>
    </BrandScope>
  );
}
