import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, makeNonce } from "@/lib/csp";

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

  it("the public form may redirect to the customer's site; the app may not post elsewhere", () => {
    expect(contentSecurityPolicy({ ...base, publicForm: true })).toContain("form-action 'self' https:");
    expect(contentSecurityPolicy(base)).toContain("form-action 'self' https://ref.supabase.co https://accounts.google.com");
  });

  it("development keeps eval for React's error stacks", () => {
    expect(contentSecurityPolicy({ ...base, isDev: true })).toContain("'unsafe-eval'");
  });

  it("a nonce is random each time", () => {
    expect(makeNonce()).not.toBe(makeNonce());
    expect(makeNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
