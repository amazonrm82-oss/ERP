import type { Metadata } from "next";

import { BrandScope } from "@/features/branding/components/brand-scope";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { logoPublicUrl } from "@/features/branding/logo";
import { callbackGroups } from "@/features/intake/callback";
import { PublicLeadForm } from "@/features/intake/components/public-lead-form";
import { getPublicForm } from "@/features/intake/public-form";
import { AccessibilityLink } from "@/components/accessibility-link";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "טופס פנייה", robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Public, no sign-in. `?embed=1` drops the page frame for use inside an iframe.
export default async function PublicFormPage({ params, searchParams }: Props) {
  const { token } = await params;
  const embed = (await searchParams).embed === "1";
  const form = await getPublicForm(token);
  const found = form !== null && form !== "not-configured" ? form : null;
  const logoUrl = found ? logoPublicUrl(found.brand.logoPath) : null;
  // SPD-05: the call-back slots still open now, in the business's time zone
  const callback = found?.callback ? callbackGroups(new Date(), found.callback.timeZone) : null;

  return (
    // FLD-04 / DSN-17: the business's colour (corrected for contrast) on its own page
    <BrandScope color={found?.brand.color ?? null}>
      <main className={cn("mx-auto w-full max-w-md px-5", embed ? "py-4" : "min-h-dvh py-10 sm:py-16")}>
        {!found ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {form === null ? "הטופס לא נמצא או שאינו פעיל כרגע." : "הטופס אינו זמין כרגע."}
          </p>
        ) : (
          <>
            {logoUrl ? <OrgLogo url={logoUrl} alt="לוגו העסק" className="mb-5 h-12 max-w-48" /> : null}
            <h1 className="text-2xl font-semibold">{found.title}</h1>
            {found.intro ? <p className="mt-1 whitespace-pre-wrap text-ink-soft">{found.intro}</p> : null}
            <div className="mt-6">
              <PublicLeadForm token={token} fields={found.fields} submitLabel={found.submitLabel} whatsappUrl={found.thanks.whatsappUrl} callback={callback} />
            </div>
          </>
        )}
        <AccessibilityLink newTab={embed} />
      </main>
    </BrandScope>
  );
}
