import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, isEmbeddablePublicPath, makeNonce } from "@/lib/csp";

import nextConfig from "../../next.config";

describe("content security policy (FXS-05)", () => {
  const base = { nonce: "abc", supabaseUrl: "https://ref.supabase.co", isDev: false, publicForm: false };

  it("scripts only with the page's nonce; no eval in production", () => {
    const csp = contentSecurityPolicy(base);
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic';");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("connects only to this site and the Supabase project, including Realtime", () => {
    expect(contentSecurityPolicy(base)).toContain("connect-src 'self' https://ref.supabase.co wss://ref.supabase.co");
    expect(contentSecurityPolicy({ ...base, supabaseUrl: "http://127.0.0.1:54321", isDev: true })).toContain("connect-src 'self' http://127.0.0.1:54321 ws://127.0.0.1:54321");
  });

  it("images from this site and from Supabase Storage (file thumbnails), nowhere else", () => {
    expect(contentSecurityPolicy(base)).toContain("img-src 'self' blob: data: https://ref.supabase.co;");
    expect(contentSecurityPolicy({ ...base, supabaseUrl: "" })).toContain("img-src 'self' blob: data:;");
  });

  it("the public form may redirect to the customer's site; the app may not post elsewhere", () => {
    expect(contentSecurityPolicy({ ...base, publicForm: true })).toContain("form-action 'self' https:");
    expect(contentSecurityPolicy(base)).toContain("form-action 'self' https://ref.supabase.co https://accounts.google.com");
  });

  it("the app is never framed; the public form may be embedded anywhere", () => {
    expect(contentSecurityPolicy(base)).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy({ ...base, publicForm: true })).toContain("frame-ancestors *");
  });

  it("the QR scan route is never embeddable, every other public page is (BIZ-03 review)", () => {
    expect(isEmbeddablePublicPath("/f/abc")).toBe(true);
    expect(isEmbeddablePublicPath("/f/book/abc")).toBe(true);
    expect(isEmbeddablePublicPath("/f/q/abc")).toBe(false);
    expect(isEmbeddablePublicPath("/o/x")).toBe(false);
  });

  it("the customer's statement page is never embeddable (BAL-04 review)", () => {
    expect(isEmbeddablePublicPath("/f/statement/abc")).toBe(false);
    expect(isEmbeddablePublicPath("/f/statementx")).toBe(true);
    expect(isEmbeddablePublicPath("/f/order/abc")).toBe(true);
  });

  it("next.config frames the same pages: DENY for the app, the QR route and the statement page; * for the other /f/ pages", async () => {
    const blocks = await nextConfig.headers!();
    const headersFor = (path: string) => {
      const out: Record<string, string> = {};
      for (const block of blocks) {
        // the regex sources are plain JS regexes; ":path*" is path-to-regexp for "anything after"
        const re = new RegExp(`^${block.source.replace("/:path*", "(?:/.*)?")}$`);
        if (re.test(path)) for (const h of block.headers) out[h.key] = h.value;
      }
      return out;
    };
    for (const path of ["/o/x", "/f/q/abc", "/f/statement/abc", "/app"]) {
      const h = headersFor(path);
      expect(h["Content-Security-Policy"], path).toBe("frame-ancestors 'none'");
      expect(h["X-Frame-Options"], path).toBe("DENY");
      expect(isEmbeddablePublicPath(path), path).toBe(false);
    }
    for (const path of ["/f/abc", "/f/book/abc", "/f/order/abc", "/f/statementx"]) {
      const h = headersFor(path);
      expect(h["Content-Security-Policy"], path).toBe("frame-ancestors *");
      expect(h["X-Frame-Options"], path).toBeUndefined();
      expect(isEmbeddablePublicPath(path), path).toBe(true);
    }
    expect(headersFor("/f/statement/abc")).toMatchObject({ "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
  });

  it("development keeps eval for React's error stacks", () => {
    expect(contentSecurityPolicy({ ...base, isDev: true })).toContain("'unsafe-eval'");
  });

  it("a nonce is random each time", () => {
    expect(makeNonce()).not.toBe(makeNonce());
    expect(makeNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
