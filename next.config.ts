import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-only "N" badge sits in the bottom corner, over the phone bottom bar
  // (and the e2e clicks there). Errors are still shown in development.
  devIndicators: false,
  async headers() {
    return [
      {
        // The app itself must never be framed by another site (clickjacking).
        source: "/((?!f/).*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        // Public lead forms are made to be embedded in customers' websites.
        source: "/f/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
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
