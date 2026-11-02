import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { markNotFound } from "@/lib/public-not-found";
import { RATE_LIMITED_TEXT } from "@/lib/public-rate-limit";

// OPS-02, owner's answers (40) ב, (41) ב and (42) ד of 2 November 2026: the secret-link pages (quote, order, statement, the
// booking-manage link) and their routes check the shared per-sender limit before their own function and record one miss after
// a "not found"; found answers never count. The lead form, the widget, the booking page and the business card never take it.

type Call = { name: string; args: Record<string, unknown>; headers: Record<string, string> };
const calls: Call[] = [];
const replies: Record<string, { data: unknown; error: unknown }> = {};

const requestMemo = new Map<unknown, Map<string, unknown>>();
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  // React's cache() memoizes per request on the server; the unit environment loads the client build, so the test gives it a
  // plain memo (one request) that is reset before each test
  const cache = <A extends unknown[], R>(fn: (...args: A) => R) => {
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!requestMemo.has(fn)) requestMemo.set(fn, new Map());
      const memo = requestMemo.get(fn)!;
      if (!memo.has(key)) memo.set(key, fn(...args));
      return memo.get(key) as R;
    };
  };
  return { ...actual, cache };
});

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      const call: Call = { name, args, headers: {} };
      const run = async () => {
        calls.push(call);
        return replies[name] ?? { data: null, error: { code: "P0002", message: "not found" } };
      };
      return {
        setHeader(key: string, value: string) {
          call.headers[key] = value;
          return this;
        },
        then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (reason: unknown) => T) {
          return run().then(resolve, reject);
        },
      };
    },
  }),
}));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, getSupabaseEnv: () => ({ url: "https://example.supabase.co", anonKey: "anon" }) };
});
const HUMAN_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": HUMAN_UA }),
  cookies: async () => ({ get: () => undefined }),
}));

const TOKEN64 = "0123456789abcdef".repeat(4);
const TOKEN32 = TOKEN64.slice(0, 32);
const HEX64 = /^[0-9a-f]{64}$/;
const names = () => calls.map((c) => c.name);

type PageModule = {
  default: (props: never) => Promise<unknown>;
  generateMetadata: (props: never) => Promise<import("next").Metadata>;
};
async function render(mod: PageModule, token = TOKEN64) {
  const props = { params: Promise.resolve({ token }), searchParams: Promise.resolve({}) } as never;
  // Next runs the two side by side in one request
  const [metadata] = await Promise.all([mod.generateMetadata(props), mod.default(props)]);
  return metadata;
}

const STATUS_QUOTE = {
  status_page: { state: "expired", number: "Q-1", title: "הצעה", valid_until: "2026-10-01", business: "עסק", logo: null, color: null, phone: null, replaced: null, draft_version: false },
};

describe("OPS-02: the shared per-sender limit of the secret-link pages", () => {
  const secret = process.env.INTAKE_IP_HASH_SECRET;
  beforeEach(() => {
    calls.length = 0;
    requestMemo.clear();
    for (const key of Object.keys(replies)) delete replies[key];
    process.env.INTAKE_IP_HASH_SECRET = "test-secret-for-ops02";
    replies.public_sender_check = { data: true, error: null };
    replies.public_sender_miss = { data: 1, error: null };
  });
  afterEach(() => {
    if (secret === undefined) delete process.env.INTAKE_IP_HASH_SECRET;
    else process.env.INTAKE_IP_HASH_SECRET = secret;
  });

  it("checks with the keyed hash of scope 'public' and follows the answer; fails open", async () => {
    const { publicSenderAllowed, recordPublicMiss } = await import("@/lib/public-sender-server");
    const { keyedIpHash } = await import("@/lib/keyed-ip-hash");
    const headers = new Headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" });
    expect(await publicSenderAllowed(headers)).toBe(true);
    expect(calls[0]).toMatchObject({ name: "public_sender_check", args: { p_sender: keyedIpHash("198.51.100.7", "public") } });
    expect(calls[0].args.p_sender).toMatch(HEX64);
    expect(calls[0].args.p_sender).not.toBe(keyedIpHash("198.51.100.7", "quote"));
    replies.public_sender_check = { data: false, error: null };
    expect(await publicSenderAllowed(headers)).toBe(false);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    replies.public_sender_check = { data: null, error: { code: "XX000", message: "boom" } };
    expect(await publicSenderAllowed(headers)).toBe(true);
    await recordPublicMiss(headers);
    expect(calls.at(-1)).toMatchObject({ name: "public_sender_miss", args: { p_sender: keyedIpHash("198.51.100.7", "public") } });
    // no address, or no secret: nothing is sent
    calls.length = 0;
    expect(await publicSenderAllowed(new Headers())).toBe(true);
    delete process.env.INTAKE_IP_HASH_SECRET;
    expect(await publicSenderAllowed(headers)).toBe(true);
    await recordPublicMiss(headers);
    log.mockRestore();
    expect(calls).toEqual([]);
  });

  it("a route records a miss only for a response its handler marked 'not found'", async () => {
    const { guardPublicRoute } = await import("@/lib/public-sender-server");
    const request = new Request("https://example.test/api/forms/x", { headers: { "x-forwarded-for": "198.51.100.7" } });
    await guardPublicRoute(request, "text", async () => markNotFound(new Response("x", { status: 404 })));
    expect(names()).toEqual(["public_sender_check", "public_sender_miss"]);
    calls.length = 0;
    // a real link's "file unavailable" 404, and a found answer, are no misses
    await guardPublicRoute(request, "text", async () => new Response("x", { status: 404 }));
    await guardPublicRoute(request, "text", async () => new Response("x", { status: 200 }));
    expect(names()).toEqual(["public_sender_check", "public_sender_check"]);
  });

  it("a refused sender gets the shared 429 and the handler never runs", async () => {
    const { guardPublicRoute } = await import("@/lib/public-sender-server");
    replies.public_sender_check = { data: false, error: null };
    const request = new Request("https://example.test/api/forms/x", { headers: { "x-forwarded-for": "198.51.100.7" } });
    const handler = vi.fn(async () => new Response("x"));
    const json = await guardPublicRoute(request, "json", handler, { headers: { "Access-Control-Allow-Origin": "*" } });
    expect(json.status).toBe(429);
    expect(json.headers.get("retry-after")).toBe("600");
    expect(json.headers.get("access-control-allow-origin")).toBe("*");
    expect(await json.json()).toEqual({ ok: false, message: RATE_LIMITED_TEXT });
    const text = await guardPublicRoute(request, "text", handler, { headers: { "Referrer-Policy": "no-referrer" } });
    expect(text.status).toBe(429);
    expect(text.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await text.text()).toBe(RATE_LIMITED_TEXT);
    expect(handler).not.toHaveBeenCalled();
  });

  it("the quote decide route: refused before the lookup; an unknown token counts one miss", async () => {
    const route = await import("@/app/api/forms/quote/[token]/decide/route");
    const post = (token: string) =>
      route.POST(
        new Request("https://example.test/api/forms/quote/x/decide", { method: "POST", headers: { "x-forwarded-for": "198.51.100.7" }, body: "{}" }),
        { params: Promise.resolve({ token }) },
      );
    // a malformed token is "not found" without a lookup: still a miss (a guess)
    expect((await post("guess")).status).toBe(404);
    expect(names()).toEqual(["public_sender_check", "public_sender_miss"]);
    calls.length = 0;
    replies.public_sender_check = { data: false, error: null };
    const response = await post(TOKEN64);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ ok: false, status: "rate_limited", message: RATE_LIMITED_TEXT });
    expect(names()).toEqual(["public_sender_check"]);
  });

  it("the quote page: a found quote is never a miss; quote_public gets the quote-scoped sender (41)", async () => {
    replies.quote_public = { data: STATUS_QUOTE, error: null };
    const { keyedIpHash } = await import("@/lib/keyed-ip-hash");
    await render((await import("@/app/f/quote/[token]/page")) as unknown as PageModule);
    expect(names()).toEqual(["public_sender_check", "quote_public"]);
    expect(calls[1].headers).toEqual({ "x-crm-sender": keyedIpHash("203.0.113.9", "quote") });
  });

  it("the quote page: not found counts ONE miss for the page and its metadata together", async () => {
    await render((await import("@/app/f/quote/[token]/page")) as unknown as PageModule);
    expect(names()).toEqual(["public_sender_check", "quote_public", "public_sender_miss"]);
  });

  it("the other secret-link pages check first and count a not-found once", async () => {
    const pages: Array<[string, () => Promise<unknown>, string]> = [
      ["order", () => import("@/app/f/order/[token]/page"), "order_public"],
      ["manage", () => import("@/app/f/book/manage/[token]/page"), "booking_manage_public"],
    ];
    for (const [label, load, read] of pages) {
      calls.length = 0;
      requestMemo.clear();
      await render((await load()) as unknown as PageModule);
      expect(names(), label).toEqual(["public_sender_check", read, "public_sender_miss"]);
    }
  });

  it("a refused sender reads nothing: the page shows the shared text and the preview stays generic", async () => {
    replies.public_sender_check = { data: false, error: null };
    const metadata = await render((await import("@/app/f/quote/[token]/page")) as unknown as PageModule);
    expect(names()).toEqual(["public_sender_check"]);
    expect(metadata.title).toBe("הצעת מחיר");
  });

  it("(42) ד: the lead form, the booking page and the business card never take the shared limit", async () => {
    replies.intake_form = { data: { inactive: true }, error: null };
    const pages: Array<[string, () => Promise<unknown>, string]> = [
      ["form", () => import("@/app/f/[token]/page"), "intake_form"],
      ["booking", () => import("@/app/f/book/[token]/page"), "booking_page_public"],
      ["card", () => import("@/app/f/card/[token]/page"), "business_card_public"],
    ];
    for (const [label, load, read] of pages) {
      calls.length = 0;
      requestMemo.clear();
      await render((await load()) as unknown as PageModule, TOKEN32);
      expect(names(), label).toEqual([read]);
    }
  });
});
