import type { Metadata } from "next";
import { headers } from "next/headers";

import { AccessibilityLink } from "@/components/accessibility-link";
import { BrandScope } from "@/features/branding/components/brand-scope";
import { BuiltWithLine } from "@/features/built-with/components/built-with-line";
import { PublicWidgetForm } from "@/features/site-widgets/components/public-widget-form";
import { getPublicWidget } from "@/features/site-widgets/public-server";
import { clientIp } from "@/lib/keyed-ip-hash";

export const metadata: Metadata = { title: "השאירו פרטים", robots: { index: false, follow: false } };

type Props = { params: Promise<{ token: string }> };

const MESSAGES = {
  "not-found": "הטופס לא נמצא או שאינו פעיל.",
  "rate-limited": "הטופס נפתח יותר מדי פעמים בזמן קצר. נסו שוב בעוד כמה דקות.",
  "not-configured": "הטופס אינו זמין כרגע.",
} as const;

/**
 * SPD-07: the site widget's short form, opened by the widget's script in a frame on the business's website (it carries
 * the host page's campaign keys and address as embed=1 + page_url, like an embedded form). No sign-in, no cookies.
 */
export default async function WidgetFormPage({ params }: Props) {
  const { token } = await params;
  const widget = await getPublicWidget(token, clientIp(await headers()));

  if (typeof widget === "string" || !widget.form) {
    return (
      <main className="mx-auto w-full max-w-md px-4 py-6">
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {MESSAGES[typeof widget === "string" ? widget : "not-found"]}
        </p>
      </main>
    );
  }

  return (
    // FLD-04 / DSN-17: the business's colour (corrected for contrast) on its own form
    <BrandScope color={widget.brand.color}>
      <main className="mx-auto w-full max-w-md px-4 py-5">
        <h1 className="text-lead font-semibold break-words">השאירו פרטים</h1>
        <p className="mt-1 mb-4 text-md text-ink-soft break-words">{widget.business} יחזרו אליכם בהקדם.</p>
        <PublicWidgetForm token={token} business={widget.business} />
        {widget.builtWith ? <BuiltWithLine /> : null}
        <AccessibilityLink />
      </main>
    </BrandScope>
  );
}
