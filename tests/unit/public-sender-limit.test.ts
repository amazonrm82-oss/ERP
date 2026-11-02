import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RATE_LIMITED_TEXT } from "@/lib/public-rate-limit";

// OPS-02, owner's answers (40) ב and (41) ב of 2 November 2026: every public page and route takes the shared per-sender limit
// (public.public_sender_take) before it looks its token up, once per request; the quote page hands its sender to quote_public.

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
const HEX64 = /^[0-9a-f]{64}$/;

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

describe("OPS-02: the shared per-sender limit", () => {
  const secret = process.env.INTAKE_IP_HASH_SECRET;
  beforeEach(() => {
    calls.length = 0;
    requestMemo.clear();
    for (const key of Object.keys(replies)) delete replies[key];
    process.env.INTAKE_IP_HASH_SECRET = "test-secret-for-ops02";
  });
  afterEach(() => {
    if (secret === undefined) delete process.env.INTAKE_IP_HASH_SECRET;
    else process.env.INTAKE_IP_HASH_SECRET = secret;
  });

  it("sends the keyed hash with scope 'public' and follows the answer", async () => {
    const { takePublicRequest } = await import("@/lib/public-sender-server");
    const { keyedIpHash } = await import("@/lib/keyed-ip-hash");
    const headers = new Headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" });
    replies.public_sender_take = { data: true, error: null };
    expect(await takePublicRequest(headers)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("public_sender_take");
    expect(calls[0].args.p_sender).toMatch(HEX64);
    expect(calls[0].args.p_sender).toBe(keyedIpHash("198.51.100.7", "public"));
    // one value per visitor across pages, never the same as a page's own scope
    expect(calls[0].args.p_sender).not.toBe(keyedIpHash("198.51.100.7", "quote"));
    replies.public_sender_take = { data: false, error: null };
    expect(await takePublicRequest(headers)).toBe(false);
    // a failed call lets the request through (each page's own limits still stand)
    replies.public_sender_take = { data: null, error: { code: "XX000", message: "boom" } };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await takePublicRequest(headers)).toBe(true);
    log.mockRestore();
  });

  it("no secret or no address: nothing is sent and the request goes on", async () => {
    const { takePublicRequest } = await import("@/lib/public-sender-server");
    expect(await takePublicRequest(new Headers())).toBe(true);
    delete process.env.INTAKE_IP_HASH_SECRET;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await takePublicRequest(new Headers({ "x-forwarded-for": "198.51.100.7" }))).toBe(true);
    log.mockRestore();
    expect(calls).toEqual([]);
  });

  it("a route's refusal is the shared 429, with its own body and headers", async () => {
    const { refusePublicRequest } = await import("@/lib/public-sender-server");
    const request = new Request("https://example.test/api/forms/x", { headers: { "x-forwarded-for": "198.51.100.7" } });
    replies.public_sender_take = { data: true, error: null };
    expect(await refusePublicRequest(request, "json")).toBeNull();
    replies.public_sender_take = { data: false, error: null };
    const json = (await refusePublicRequest(request, "json", { headers: { "Access-Control-Allow-Origin": "*" } }))!;
    expect(json.status).toBe(429);
    expect(json.headers.get("retry-after")).toBe("600");
    expect(json.headers.get("access-control-allow-origin")).toBe("*");
    expect(await json.json()).toEqual({ ok: false, message: RATE_LIMITED_TEXT });
    const text = (await refusePublicRequest(request, "text", { headers: { "Referrer-Policy": "no-referrer" } }))!;
    expect(text.status).toBe(429);
    expect(text.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await text.text()).toBe(RATE_LIMITED_TEXT);
  });

  it("a refused decision never reaches the token's own function", async () => {
    replies.public_sender_take = { data: false, error: null };
    const route = await import("@/app/api/forms/quote/[token]/decide/route");
    const response = await route.POST(
      new Request("https://example.test/api/forms/quote/x/decide", { method: "POST", headers: { "x-forwarded-for": "198.51.100.7" }, body: "{}" }),
      { params: Promise.resolve({ token: TOKEN64 }) },
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ ok: false, status: "rate_limited", message: RATE_LIMITED_TEXT });
    expect(calls.map((c) => c.name)).toEqual(["public_sender_take"]);
  });

  it("a page view counts once (page + its metadata), before the lookup; quote_public gets the quote-scoped sender", async () => {
    replies.public_sender_take = { data: true, error: null };
    const { keyedIpHash } = await import("@/lib/keyed-ip-hash");
    await render((await import("@/app/f/quote/[token]/page")) as unknown as PageModule);
    expect(calls.map((c) => c.name)).toEqual(["public_sender_take", "quote_public"]);
    expect(calls[1].headers).toEqual({ "x-crm-sender": keyedIpHash("203.0.113.9", "quote") });
  });

  it("every customer page takes it once per request, first", async () => {
    replies.public_sender_take = { data: true, error: null };
    replies.intake_form = { data: { inactive: true }, error: null };
    const pages: Array<[string, () => Promise<unknown>, string]> = [
      ["order", () => import("@/app/f/order/[token]/page"), "order_public"],
      ["card", () => import("@/app/f/card/[token]/page"), "business_card_public"],
      ["booking", () => import("@/app/f/book/[token]/page"), "booking_page_public"],
      ["manage", () => import("@/app/f/book/manage/[token]/page"), "booking_manage_public"],
      ["form", () => import("@/app/f/[token]/page"), "intake_form"],
    ];
    for (const [label, load, read] of pages) {
      calls.length = 0;
      requestMemo.clear();
      const token = label === "card" || label === "booking" || label === "form" ? TOKEN64.slice(0, 32) : TOKEN64;
      await render((await load()) as unknown as PageModule, token);
      expect(calls.map((c) => c.name), label).toEqual(["public_sender_take", read]);
    }
  });

  it("a refused sender reads nothing: the page shows the shared text and the preview stays generic", async () => {
    replies.public_sender_take = { data: false, error: null };
    const metadata = await render((await import("@/app/f/quote/[token]/page")) as unknown as PageModule);
    expect(calls.map((c) => c.name)).toEqual(["public_sender_take"]);
    expect(metadata.title).toBe("הצעת מחיר");
  });
});
