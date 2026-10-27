import type { Metadata } from "next";
import { headers } from "next/headers";
import { cache } from "react";

import { AccessibilityLink } from "@/components/accessibility-link";
import { buttonClasses } from "@/components/ui/button";
import { ChatIcon, MailIcon, PhoneIcon } from "@/components/ui/icons";
import { BrandScope } from "@/features/branding/components/brand-scope";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { logoPublicUrl } from "@/features/branding/logo";
import { BuiltWithLine } from "@/features/built-with/components/built-with-line";
import { PublicCardForm } from "@/features/business-cards/components/public-card-form";
import { cardVCardPath } from "@/features/business-cards/paths";
import { getPublicCard } from "@/features/business-cards/public-server";
import { clientIp } from "@/lib/keyed-ip-hash";
import { businessPreview, genericPreview, PREVIEW_TEXTS } from "@/lib/link-preview";

type Props = { params: Promise<{ token: string }> };

// WAB-05: the link's preview and the page share ONE read per request (business_card_public counts a view per sender)
const loadCard = cache(async (token: string) => getPublicCard(token, clientIp(await headers())));

/** WAB-05: the link's preview: the rep's public name and the business, with the business's logo. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const card = await loadCard((await params).token);
  const t = PREVIEW_TEXTS.card;
  if (typeof card === "string") return genericPreview(t.what, t.description);
  // the name is what the rep marked public on the card (else the business's name, BIZ-02); never a customer's
  const who = card.name.trim() && card.name.trim() !== card.business.trim() ? `${card.name.trim()} · ${card.business}` : card.business;
  return businessPreview({ what: t.what, joiner: t.joiner, business: who, siteName: card.business, logoUrl: logoPublicUrl(card.brand.logoPath), description: card.jobTitle ? `${card.jobTitle} · ${t.description}` : t.description });
}

const MESSAGES = {
  "not-found": "הכרטיס לא נמצא או שאינו פעיל.",
  "rate-limited": "הכרטיס נפתח יותר מדי פעמים בזמן קצר. נסו שוב בעוד כמה דקות.",
  "not-configured": "הכרטיס אינו זמין כרגע.",
} as const;

/** BIZ-02: a rep's public business card. No sign-in, no cookies; only what the rep marked public. */
export default async function PublicCardPage({ params }: Props) {
  const { token } = await params;
  const card = await loadCard(token);

  if (typeof card === "string") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {MESSAGES[card]}
        </p>
        <AccessibilityLink />
      </main>
    );
  }

  const logoUrl = logoPublicUrl(card.brand.logoPath);
  return (
    // FLD-04 / DSN-17: the business's colour (corrected for contrast) on its own page
    <BrandScope color={card.brand.color}>
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        {logoUrl ? <OrgLogo url={logoUrl} alt={`הלוגו של ${card.business}`} className="mb-5 h-12 max-w-48" /> : null}
        <h1 className="text-2xl font-semibold break-words">{card.name}</h1>
        <p className="mt-1 text-md text-ink-soft">{[card.jobTitle, card.business].filter(Boolean).join(" · ")}</p>
        {card.about ? <p className="mt-3 whitespace-pre-wrap break-words">{card.about}</p> : null}

        <ul className="mt-6 grid gap-2" aria-label="דרכים ליצירת קשר">
          {card.phone ? (
            <li>
              <a href={`tel:${card.phone.replace(/[^\d+]/g, "")}`} className={buttonClasses("secondary", "md", "w-full justify-start")}>
                <PhoneIcon className="size-4.5" aria-hidden="true" />
                <span>
                  חיוג <span dir="ltr">{card.phone}</span>
                </span>
              </a>
            </li>
          ) : null}
          {card.whatsapp ? (
            <li>
              <a href={`https://wa.me/${card.whatsapp}`} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "md", "w-full justify-start")}>
                <ChatIcon className="size-4.5" aria-hidden="true" />
                <span>הודעה ב-WhatsApp</span>
                <span className="sr-only"> (נפתח בחלון חדש)</span>
              </a>
            </li>
          ) : null}
          {card.email ? (
            <li>
              <a href={`mailto:${card.email}`} className={buttonClasses("secondary", "md", "w-full justify-start")}>
                <MailIcon className="size-4.5" aria-hidden="true" />
                <span dir="ltr">{card.email}</span>
              </a>
            </li>
          ) : null}
          {card.website ? (
            <li>
              <a href={card.website} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "md", "w-full justify-start")}>
                <span>לאתר</span>
                <span className="sr-only"> (נפתח בחלון חדש)</span>
              </a>
            </li>
          ) : null}
          <li>
            <a href={cardVCardPath(token)} className={buttonClasses("primary", "md", "w-full")}>
              שמירה באנשי הקשר
            </a>
          </li>
        </ul>

        {card.form ? (
          <section aria-labelledby="card-form" className="mt-8 space-y-4">
            <h2 id="card-form" className="text-lead font-semibold">
              השאירו פרטים
            </h2>
            <PublicCardForm token={token} rep={card.name} />
          </section>
        ) : null}
        {card.builtWith ? <BuiltWithLine /> : null}
        <AccessibilityLink />
      </main>
    </BrandScope>
  );
}
