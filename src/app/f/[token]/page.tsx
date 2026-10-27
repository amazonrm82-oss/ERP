import type { Metadata } from "next";
import { cache } from "react";

import { BrandScope } from "@/features/branding/components/brand-scope";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { BuiltWithLine } from "@/features/built-with/components/built-with-line";
import { logoPublicUrl } from "@/features/branding/logo";
import { PublicLeadForm } from "@/features/intake/components/public-lead-form";
import { getPublicForm, INACTIVE_FORM_TEXT } from "@/features/intake/public-form";
import { AccessibilityLink } from "@/components/accessibility-link";
import { cn } from "@/lib/cn";
import { genericPreview, linkPreviewMetadata, PREVIEW_TEXTS } from "@/lib/link-preview";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// WAB-05: the link's preview and the page share ONE read per request
const loadForm = cache((token: string) => getPublicForm(token));

/**
 * WAB-05: the link's preview: the form's own title and intro (written by the business) and its logo. intake_form() does
 * not return the business's name, so it is in the preview only when the form's title carries it.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const form = await loadForm((await params).token);
  const t = PREVIEW_TEXTS.form;
  if (form === null || form === "inactive" || form === "not-configured") return genericPreview(t.what, t.description);
  return linkPreviewMetadata(
    { title: form.title || t.what, description: form.intro ?? t.description, business: null, logoUrl: logoPublicUrl(form.brand.logoPath) },
    { absoluteTitle: true },
  );
}

// Public, no sign-in. `?embed=1` drops the page frame for use inside an iframe.
export default async function PublicFormPage({ params, searchParams }: Props) {
  const { token } = await params;
  const embed = (await searchParams).embed === "1";
  const form = await loadForm(token);
  const found = form !== null && form !== "not-configured" && form !== "inactive" ? form : null;
  const logoUrl = found ? logoPublicUrl(found.brand.logoPath) : null;

  return (
    // FLD-04 / DSN-17: the business's colour (corrected for contrast) on its own page
    <BrandScope color={found?.brand.color ?? null}>
      <main className={cn("mx-auto w-full max-w-md px-5", embed ? "py-4" : "min-h-dvh py-10 sm:py-16")}>
        {!found ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {form === "inactive" ? INACTIVE_FORM_TEXT : form === null ? "הטופס לא נמצא או שאינו פעיל כרגע." : "הטופס אינו זמין כרגע."}
          </p>
        ) : (
          <>
            {logoUrl ? <OrgLogo url={logoUrl} alt="לוגו העסק" className="mb-5 h-12 max-w-48" /> : null}
            <h1 className="text-2xl font-semibold">{found.title}</h1>
            {found.intro ? <p className="mt-1 whitespace-pre-wrap text-ink-soft">{found.intro}</p> : null}
            <div className="mt-6">
              <PublicLeadForm token={token} fields={found.fields} submitLabel={found.submitLabel} whatsappUrl={found.thanks.whatsappUrl} callback={found.callback} channelChoice={found.channelChoice} localeChoice={found.localeChoice} products={found.products} marketingConsent={found.marketingConsent} />
            </div>
          </>
        )}
        {/* FLD-04: the small "נבנה ב-Mexuz" line, unless the business's plan removes it */}
        {found?.builtWith ? <BuiltWithLine /> : null}
        <AccessibilityLink newTab={embed} />
      </main>
    </BrandScope>
  );
}
