import { afterEach, describe, expect, it, vi } from "vitest";

import { anonHealthCall, HEALTH_TIMEOUT_MS, healthResponse, type HealthCall } from "@/features/health/health-server";

// OPS-05 (owner (72) ב): GET /api/health answers 200 {ok:true} only when public.health_check() answered true in time;
// anything else is 503 {ok:false}, never with an error text, and never cached.

async function expectReply(res: Response, status: number, ok: boolean) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await res.text()).toBe(JSON.stringify({ ok }));
}

describe("health route (OPS-05)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("answers 200 {ok:true} when the database answers true", async () => {
    const call: HealthCall = vi.fn(async () => ({ data: true, error: null }));
    await expectReply(await healthResponse(call), 200, true);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("answers 503 for any answer but true", async () => {
    for (const data of [false, null, "true", 1, { ok: true }]) {
      await expectReply(await healthResponse(async () => ({ data, error: null })), 503, false);
    }
  });

  it("answers 503 without the error text when the call returns an error or throws", async () => {
    const secret = "relation \"public.leads\" does not exist at 10.0.0.5";
    const errored = await healthResponse(async () => ({ data: true, error: { message: secret } }));
    await expectReply(errored, 503, false);
    const rejected = await healthResponse(async () => Promise.reject(new Error(secret)));
    await expectReply(rejected, 503, false);
    const thrown = await healthResponse(() => {
      throw new Error(secret);
    });
    await expectReply(thrown, 503, false);
  });

  it("answers 503 after the timeout and aborts the call", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = healthResponse((s) => {
      signal = s;
      return new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expectReply(await pending, 503, false);
  });

  it("a slow but true answer within the timeout still counts", async () => {
    vi.useFakeTimers();
    const pending = healthResponse(() => new Promise((resolve) => setTimeout(() => resolve({ data: true, error: null }), 2000)));
    await vi.advanceTimersByTimeAsync(2000);
    await expectReply(await pending, 200, true);
  });

  it("answers 503 when the site is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect(anonHealthCall()).toBeNull();
    await expectReply(await healthResponse(null), 503, false);
  });

  it("calls the anon REST endpoint for health_check with the anon key and no session", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    const fetchMock = vi.fn(async () => new Response("true", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const call = anonHealthCall();
      expect(call).not.toBeNull();
      await expectReply(await healthResponse(call), 200, true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string | URL, RequestInit];
      expect(String(url)).toBe("https://example.supabase.co/rest/v1/rpc/health_check");
      const headers = new Headers(init.headers);
      expect(headers.get("apikey")).toBe("anon-key");
      expect(headers.get("authorization")).toBe("Bearer anon-key");
      expect(headers.get("cookie")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("health route is public at its exact path only (OPS-05)", () => {
  it("/api/health is public; look-alike paths are not", async () => {
    const { isPublicPath } = await import("@/lib/supabase/proxy");
    expect(isPublicPath("/api/health")).toBe(true);
    for (const path of ["/api/healthz", "/api/health/", "/api/health/x", "/api/health.json", "/api/healthcheck"]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });
});
