import type { Metadata } from "next";
import { headers } from "next/headers";
import { cache } from "react";

import { BrandScope } from "@/features/branding/components/brand-scope";
import { PublicBrandHeader, PublicPageFooter } from "@/features/branding/components/public-page";
import { logoPublicUrl } from "@/features/branding/logo";
import { PublicLeadForm } from "@/features/intake/components/public-lead-form";
import { PublicPrivacyNotice } from "@/features/privacy-center/components/public-privacy-notice";
import { getPublicForm, INACTIVE_FORM_TEXT } from "@/features/intake/public-form";
import { cn } from "@/lib/cn";
import { BotPreviewPage } from "@/features/link-preview/components/bot-preview-page";
import { botPreviewMetadata } from "@/features/link-preview/bot-preview";
import { isPreviewBotRequest, loadBotPreview } from "@/features/link-preview/bot-request";
import { genericPreview, linkPreviewMetadata, PREVIEW_TEXTS } from "@/lib/link-preview";
import { RATE_LIMITED_PAGE_TEXT } from "@/lib/public-rate-limit";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// WAB-05: the link's preview and the page share ONE read per request
// OPS-02: the view counts against the sender's limit (300 in 10 minutes per form, app.form_view_limit)
const loadForm = cache(async (token: string) => getPublicForm(token, await headers()));

/**
 * WAB-05: the link's preview: the form's own title and intro (written by the business) and its logo. intake_form() does
 * not return the business's name, so it is in the preview only when the form's title carries it.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // WAB-05 follow-up (owner, 27 October 2026): a listed preview bot gets the business's display name and logo only; the page's
  // own read (which counts a view) never runs for it
  if (await isPreviewBotRequest()) return botPreviewMetadata("form", await loadBotPreview("form", (await params).token));
  const form = await loadForm((await params).token);
  const t = PREVIEW_TEXTS.form;
  if (typeof form !== "object" || form === null) return genericPreview(t.what, t.description);
  return linkPreviewMetadata(
    { title: form.title || t.what, description: form.intro ?? t.description, business: null, logoUrl: logoPublicUrl(form.brand.logoPath) },
    { absoluteTitle: true },
  );
}

// Public, no sign-in. `?embed=1` drops the page frame for use inside an iframe.
export default async function PublicFormPage({ params, searchParams }: Props) {
  const { token } = await params;
  const embed = (await searchParams).embed === "1";
  // WAB-05 follow-up: a listed preview bot gets one line, and nothing of the page is read or counted
  if (await isPreviewBotRequest()) return <BotPreviewPage kind="form" state={await loadBotPreview("form", token)} />;
  const form = await loadForm(token);
  const found = form !== null && typeof form === "object" ? form : null;
  const logoUrl = found ? logoPublicUrl(found.brand.logoPath) : null;

  return (
    // FLD-04 / DSN-17: the business's colour (corrected for contrast) on its own page
    <BrandScope color={found?.brand.color ?? null}>
      <main className={cn("mx-auto w-full max-w-md px-5", embed ? "py-4" : "min-h-dvh py-10 sm:py-16")}>
        {!found ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {form === "inactive" ? INACTIVE_FORM_TEXT : form === "rate-limited" ? RATE_LIMITED_PAGE_TEXT : form === null ? "הטופס לא נמצא או שאינו פעיל כרגע." : "הטופס אינו זמין כרגע."}
          </p>
        ) : (
          <>
            {/* DSN-17: the family header; intake_form() answers the logo and colour, not the business's name */}
            <PublicBrandHeader logoUrl={logoUrl} business={null} title={found.title}>
              {found.intro ? <p className="mt-1 whitespace-pre-wrap text-ink-soft">{found.intro}</p> : null}
            </PublicBrandHeader>
            <div className="mt-6">
              <PublicLeadForm token={token} fields={found.fields} submitLabel={found.submitLabel} whatsappUrl={found.thanks.whatsappUrl} callback={found.callback} channelChoice={found.channelChoice} localeChoice={found.localeChoice} products={found.products} marketingConsent={found.marketingConsent} />
            </div>
            {/* LEGAL-2 (4): the privacy notice (section 11) */}
            <PublicPrivacyNotice contact={found.notice ?? { business: null, email: null, phone: null }} />
          </>
        )}
        {/* FLD-04: the small "נבנה ב-Mexuz" line, unless the business's plan removes it */}
        <PublicPageFooter builtWith={found?.builtWith === true} newTab={embed} />
      </main>
    </BrandScope>
  );
}
