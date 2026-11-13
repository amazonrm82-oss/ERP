import type { NextConfig } from "next";
// Next's own list of bots that get the metadata in <head> before the body (no streamed metadata)
import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/html-bots";

/**
 * WAB-05 (review L3): Next's default list plus the two preview fetchers of src/lib/preview-bots.ts it lacks, so their
 * link preview reads the Open Graph tags in <head> instead of a streamed tail. Setting the option replaces the default list,
 * so the default is kept whole (unit test `next-config-bots`).
 */
export const HTML_LIMITED_BOTS = new RegExp(`${HTML_LIMITED_BOT_UA_RE.source}|TelegramBot|Facebot`, "i");

const nextConfig: NextConfig = {
  // The dev-only "N" badge sits in the bottom corner, over the phone bottom bar
  // (and the e2e clicks there). Errors are still shown in development.
  devIndicators: false,
  htmlLimitedBots: HTML_LIMITED_BOTS,
  async headers() {
    return [
      {
        // The app itself must never be framed by another site (clickjacking); nor the QR scan route, whose page
        // before an external link (BIZ-03) names the business on our domain, nor the customer's statement page (BAL-04),
        // which shows a customer's debts, nor the preferences and unsubscribe pages (CNS-09/10), nor a document for signature
        // (SGN-02: a signature must never be clicked inside another site), nor a library item sent by a tracked link (LIB-02), nor the prefill form that shows a person's details (BIZ-05). Same prefixes as NOT_EMBEDDABLE_PUBLIC_PREFIXES in src/lib/csp.ts.
        source: "/((?!f/(?!q/|statement/|prefs/|unsub/|sign/|lib/|fill/)).*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        // Public lead forms are made to be embedded in customers' websites (every /f/ page but the QR scan route and
        // the statement page, the preferences and unsubscribe pages and the signing page).
        source: "/f/((?!q/|statement/|prefs/|unsub/|sign/|lib/|fill/).*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        // The statement page (BAL-04) is never framed (the block above) and, like every customer page, sends no
        // referrer: its address holds the secret token. Later keys override the block above.
        source: "/f/statement/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        // CNS-09 / CNS-10 (preferences, unsubscribe), SGN-02 (signing) and LIB-02 (a tracked library link): like the statement
        // page, never framed, no referrer
        source: "/f/:page(prefs|unsub|sign|lib)/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        // The service worker must always be fetched fresh, or a fix never reaches installed browsers.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
