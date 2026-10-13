import type { Metadata } from "next";

import { AccessibilityLink } from "@/components/accessibility-link";
import { BrandScope } from "@/features/branding/components/brand-scope";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { logoPublicUrl } from "@/features/branding/logo";
import { QrImage } from "@/features/intake/components/qr-image";
import { getPublicForm } from "@/features/intake/public-form";
import { formQrUrl } from "@/features/intake/qr-link";
import { PrintButton } from "@/features/legal/components/print-button";
import { encodeQr } from "@/lib/qr";
import { siteOrigin } from "@/lib/site-origin";

export const metadata: Metadata = { title: "קוד QR לטופס", robots: { index: false, follow: false } };

type Props = { params: Promise<{ token: string }> };

// CAP-03: a page to print and hang up. Public like the form itself: it shows
// only the form's title and its address, with the business's logo and colour
// (FLD-04, CAP-05) like the form it points to. The code itself stays dark on
// white, so every camera reads it.
export default async function FormQrPosterPage({ params }: Props) {
  const { token } = await params;
  const [form, origin] = await Promise.all([getPublicForm(token), siteOrigin()]);
  const pageUrl = `${origin}/f/${token}`;

  const found = form !== null && form !== "not-configured" ? form : null;
  const logoUrl = found ? logoPublicUrl(found.brand.logoPath) : null;

  return (
    <BrandScope color={found?.brand.color ?? null}>
      <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col items-center px-5 py-10 text-center print:min-h-0 print:py-0">
        {!found ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {form === null ? "הטופס לא נמצא או שאינו פעיל כרגע." : "הטופס אינו זמין כרגע."}
          </p>
        ) : (
          <>
            {logoUrl ? <OrgLogo url={logoUrl} alt="לוגו העסק" className="mb-6 h-16 max-w-56" /> : null}
            <h1 className="text-2xl font-semibold text-balance">{found.title}</h1>
            <span aria-hidden="true" className="mt-4 block h-1 w-16 rounded-full bg-accent" />
            <p className="mt-4 text-lead text-ink-soft">סורקים את הקוד במצלמה של הטלפון וממלאים את הפרטים</p>
            <QrImage code={encodeQr(formQrUrl(pageUrl))} label={`קוד QR לטופס ${found.title}`} className="mt-8 aspect-square w-full max-w-80 rounded-lg" />
            <p className="mt-6 text-sm text-ink-soft">או בכתובת</p>
            <p dir="ltr" className="mt-1 text-md font-medium break-all">
              {pageUrl}
            </p>
            <div className="mt-10 print:hidden">
              <PrintButton />
            </div>
          </>
        )}
        <AccessibilityLink className="print:hidden" />
      </main>
    </BrandScope>
  );
}
