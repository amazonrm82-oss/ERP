import type { Metadata } from "next";

import { turnstileSiteKey } from "@/features/auth/turnstile-server";
import { ContactSection } from "@/features/landing/components/contact-section";
import { FlowSection } from "@/features/landing/components/flow";
import { IndustryLinks } from "@/features/landing/components/industry-page";
import styles from "@/features/landing/components/landing.module.css";
import { LANDING_ROOT_ID } from "@/features/landing/components/motion";
import { PricingSection } from "@/features/landing/components/pricing-section";
import { Cta, Faq, Hero, LandingFooter, LandingNav, Marquee, ProductBlocks, Quote, Steps } from "@/features/landing/components/sections";
import { StandaloneRedirect } from "@/features/landing/components/standalone-redirect";
import { INDUSTRY_PAGE_LINKS } from "@/features/landing/industries";
import { readPublicPlans } from "@/features/landing/price-list-server";
import { providerReadiness, waitingForProvider } from "@/features/landing/provider-readiness";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/app";
import { SUPPORT } from "@/lib/support";

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} | ${APP_DESCRIPTION}` },
  description: "Mexuz — מערכת לניהול לידים, לקוחות ועסקאות לעסקים קטנים ובינוניים בישראל. בעברית, בטלפון ובמחשב.",
  // the one page search engines should find (LND-11)
  robots: { index: true, follow: true },
};

// The public landing page (LND-01 to LND-05, LND-09 to LND-13; LND-20 v2, owner 12 November 2026: the approved prototype, one
// to one in structure, texts and order, always dark navy). A signed-in visitor never sees it: the proxy sends them into the app
// first (LND-06). LND-13: the price list comes from public.plans_public() (anon), cached an hour; the page is rendered per
// request so a failed read is never kept in a prerendered page. No number on the page is invented: the product pictures carry
// demo data only.
export const dynamic = "force-dynamic";
export default async function LandingPage() {
  const plans = await readPublicPlans();
  // owner (339) ב: read from the provider configuration on the server; only feature keys go on
  const waiting = waitingForProvider(providerReadiness());
  return (
    <div id={LANDING_ROOT_ID} className={styles.page} data-paused="false">
      <StandaloneRedirect />
      <LandingNav />
      <main className="flex-1">
        <Hero />
        <Marquee />
        <FlowSection />
        <Steps />
        <ProductBlocks />
        {/* VRT-02: the industry pages */}
        <IndustryLinks pages={INDUSTRY_PAGE_LINKS} />
        <PricingSection plans={plans} waiting={waiting} />
        <Quote />
        <Faq />
        {/* RVW-99: the widget only while the server checks it (both keys set) */}
        <ContactSection whatsappHref={SUPPORT.whatsappHref} turnstileSiteKey={turnstileSiteKey()} />
        <Cta />
      </main>
      <LandingFooter />
    </div>
  );
}
