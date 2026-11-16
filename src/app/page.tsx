import type { Metadata } from "next";
import { headers } from "next/headers";
import { after } from "next/server";

import { MAIN_CONTENT_ID } from "@/components/skip-link";
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
import { landingSource, notAVisit, signupClickHref } from "@/features/landing/measure";
import { recordLandingEvent } from "@/features/landing/measure-server";
import { readPublicPlans } from "@/features/landing/price-list-server";
import { providerReadiness, waitingForProvider } from "@/features/landing/provider-readiness";
import { jsonLdText, landingJsonLd } from "@/features/seo/json-ld";
import { publicPageMetadata } from "@/features/seo/page-metadata";
import { cspNonce } from "@/features/theme/theme";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";
import { configuredSiteUrl } from "@/lib/site-origin";
import { SUPPORT } from "@/lib/support";

// the one page search engines should find first (LND-11); WEB-03: canonical, Open Graph, Twitter
export const metadata: Metadata = publicPageMetadata({
  title: `${APP_NAME} | ${APP_DESCRIPTION}`,
  absoluteTitle: true,
  description: "Mexuz — מערכת לניהול לידים, לקוחות ועסקאות לעסקים קטנים ובינוניים בישראל. בעברית, בטלפון ובמחשב.",
  path: paths.landing,
  index: true,
});

// The public landing page (LND-01 to LND-05, LND-09 to LND-13; LND-20 v2, owner 12 November 2026: the approved prototype, one
// to one in structure, texts and order, always dark navy). A signed-in visitor never sees it: the proxy sends them into the app
// first (LND-06). LND-13: the price list comes from public.plans_public() (anon), cached an hour; the page is rendered per
// request so a failed read is never kept in a prerendered page. No number on the page is invented: the product pictures carry
// demo data only.
// LND-14 (owner (388) א): the visit is counted on the server after the page is sent (no script, no cookie, no visitor id), by
// utm_source only; a prefetch or a link-preview fetcher is not counted. The sign-up buttons go through /go/signup, which counts
// the press and carries the source on.
export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export default async function LandingPage({ searchParams }: Props) {
  const source = landingSource((await searchParams).utm_source);
  const requestHeaders = new Headers(await headers());
  if (!notAVisit(requestHeaders)) after(() => recordLandingEvent("visit", source, requestHeaders));
  const signupHref = signupClickHref(source);
  const plans = await readPublicPlans();
  // owner (339) ב: read from the provider configuration on the server; only feature keys go on
  const waiting = waitingForProvider(providerReadiness());
  return (
    <>
    {/* WEB-03: structured data (name, address, logo, what the product is; no price or rating); a data block, never run */}
    <script
      type="application/ld+json"
      nonce={cspNonce(requestHeaders.get("content-security-policy"))}
      dangerouslySetInnerHTML={{ __html: jsonLdText(landingJsonLd(configuredSiteUrl())) }}
    />
    <div id={LANDING_ROOT_ID} className={styles.page} data-paused="false">
      <StandaloneRedirect />
      <LandingNav signupHref={signupHref} />
      <main id={MAIN_CONTENT_ID} className="flex-1">
        <Hero signupHref={signupHref} />
        <Marquee />
        <FlowSection />
        <Steps />
        <ProductBlocks />
        {/* VRT-02: the industry pages */}
        <IndustryLinks pages={INDUSTRY_PAGE_LINKS} />
        <PricingSection plans={plans} waiting={waiting} signupHref={signupHref} />
        <Quote />
        <Faq />
        {/* RVW-99: the widget only while the server checks it (both keys set) */}
        <ContactSection whatsappHref={SUPPORT.whatsappHref} turnstileSiteKey={turnstileSiteKey()} />
        <Cta signupHref={signupHref} />
      </main>
      <LandingFooter />
    </div>
    </>
  );
}
