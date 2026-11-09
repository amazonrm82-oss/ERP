import { createHmac, randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptSecret, parseSecretKey } from "@/features/integrations/crypto";
import { finishLeadFrom } from "@/features/meta-leads/fields";
import { createFakeGraphProvider } from "@/features/meta-leads/graph/fake";
import { PROVIDER_TIMEOUT_MS, withTimeout } from "@/features/meta-leads/timeout";
import { metaGraphProvider } from "@/features/meta-leads/graph/select";
import { metaChallenge, metaSignatureValid } from "@/features/meta-leads/signature";
import { sweepRoute, verifyRoute, webhookRoute, type Claimed, type MetaLeadsDb, type MetaLeadsDeps } from "@/features/meta-leads/webhook";
import { leadgenWebhook, MAX_LEADS } from "@/features/meta-leads/webhook-payload";

const SECRET = "app-secret-for-tests";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const ORG = "11111111-1111-4111-8111-111111111111";
const CONN = "22222222-2222-4222-8222-222222222222";

const webhookBody = (leads: { page?: string; lead: string; form?: string }[]) =>
  JSON.stringify({
    object: "page",
    entry: leads.map((l) => ({
      id: l.page ?? "1001",
      time: 1,
      changes: [{ field: "leadgen", value: { leadgen_id: l.lead, page_id: l.page ?? "1001", form_id: l.form ?? "2002", created_time: 1 } }],
    })),
  });

function fakeDb(overrides: Partial<MetaLeadsDb> = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const db: MetaLeadsDb = {
    async receive(...args) {
      calls.push({ fn: "receive", args });
      return { status: "ok", new: 1, arrivals: ["a1"] };
    },
    async claim(...args) {
      calls.push({ fn: "claim", args });
      return [];
    },
    async finish(...args) {
      calls.push({ fn: "finish", args });
      return "accepted";
    },
    ...overrides,
  };
  return { db, calls };
}

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://app.example/api/meta/leads", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.restoreAllMocks());

describe("CAP-11: the webhook's signature and verification", () => {
  it("accepts only the HMAC-SHA256 of the raw body with the App Secret", () => {
    const body = webhookBody([{ lead: "5" }]);
    const raw = new TextEncoder().encode(body);
    expect(metaSignatureValid(raw, sign(body), SECRET)).toBe(true);
    expect(metaSignatureValid(raw, sign(body).toUpperCase().replace("SHA256=", "sha256="), SECRET)).toBe(true);
    expect(metaSignatureValid(raw, sign(body, "other"), SECRET)).toBe(false);
    expect(metaSignatureValid(new TextEncoder().encode(body + " "), sign(body), SECRET)).toBe(false);
    expect(metaSignatureValid(raw, sign(body).slice(0, -2), SECRET)).toBe(false);
    expect(metaSignatureValid(raw, sign(body).replace("sha256=", "sha1="), SECRET)).toBe(false);
    expect(metaSignatureValid(raw, null, SECRET)).toBe(false);
    expect(metaSignatureValid(raw, sign(body, ""), "")).toBe(false);
  });

  it("answers the challenge only for subscribe with the exact verify token", () => {
    const params = (p: Record<string, string>) => new URLSearchParams(p);
    expect(metaChallenge(params({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "1158201444" }), "tok")).toBe("1158201444");
    expect(metaChallenge(params({ "hub.mode": "subscribe", "hub.verify_token": "tok2", "hub.challenge": "1" }), "tok")).toBeNull();
    expect(metaChallenge(params({ "hub.mode": "unsubscribe", "hub.verify_token": "tok", "hub.challenge": "1" }), "tok")).toBeNull();
    expect(metaChallenge(params({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "<script>" }), "tok")).toBeNull();
    expect(metaChallenge(params({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" }), "")).toBeNull();
  });

  it("the GET route answers only the challenge, as plain text, and 503 without a verify token", async () => {
    const url = "https://app.example/api/meta/leads?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=42";
    const res = verifyRoute(new Request(url), { env: { META_VERIFY_TOKEN: "tok" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("42");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(verifyRoute(new Request(url.replace("tok&", "bad&")), { env: { META_VERIFY_TOKEN: "tok" } }).status).toBe(403);
    expect(verifyRoute(new Request(url), { env: {} }).status).toBe(503);
  });
});

describe("CAP-11: the webhook body", () => {
  it("keeps only page, lead and form ids, each lead once", () => {
    const parsed = leadgenWebhook(JSON.parse(webhookBody([{ lead: "10" }, { lead: "10" }, { lead: "11", form: "x" }, { page: "1002", lead: "12" }])));
    expect(parsed).toEqual([
      { pageId: "1001", leads: [{ id: "10", form_id: "2002" }, { id: "11", form_id: null }] },
      { pageId: "1002", leads: [{ id: "12", form_id: "2002" }] },
    ]);
    expect(leadgenWebhook({ object: "user", entry: [] })).toBeNull();
    expect(leadgenWebhook(null)).toBeNull();
    expect(leadgenWebhook({ object: "page", entry: [{ changes: [{ field: "feed", value: { leadgen_id: "1" } }] }] })).toEqual([]);
    const many = JSON.parse(webhookBody(Array.from({ length: MAX_LEADS + 1 }, (_, i) => ({ lead: String(100 + i) }))));
    expect(leadgenWebhook(many)).toBeNull();
  });

  it("maps a Graph lead to the intake's fields; other answers become message lines", () => {
    expect(
      finishLeadFrom({
        field_data: [
          { name: "first_name", values: ["דנה"] },
          { name: "last_name", values: ["כהן"] },
          { name: "EMAIL", values: ["Dana@Example.test"] },
          { name: "phone_number", values: ["+972501234567"] },
          { name: "מה התקציב?", values: ["עד 5,000"] },
          { name: "שירותים", values: ["א", "ב"] },
          { name: "ריק", values: [""] },
        ],
        platform: "ig",
        campaign_name: " קיץ\u0007 ",
      }),
    ).toEqual({
      full_name: "דנה כהן",
      phone: "+972501234567",
      email: "dana@example.test",
      company_name: null,
      message: "מה התקציב?: עד 5,000\nשירותים: א, ב",
      platform: "ig",
      campaign: "קיץ",
    });
    expect(finishLeadFrom({ field_data: [] })).toMatchObject({ platform: "fb", full_name: null, message: null, campaign: null });
  });
});

describe("CAP-11: the Graph provider", () => {
  it("is the fake only off Vercel or on a development deployment; nothing by default", () => {
    expect(metaGraphProvider({})).toBeNull();
    expect(metaGraphProvider({ META_LEADS_PROVIDER: "real" })).toBeNull();
    expect(metaGraphProvider({ META_LEADS_PROVIDER: "fake" })?.code).toBe("fake");
    expect(metaGraphProvider({ META_LEADS_PROVIDER: "fake", VERCEL_ENV: "development" })?.code).toBe("fake");
    expect(metaGraphProvider({ META_LEADS_PROVIDER: "fake", VERCEL_ENV: "production" })).toBeNull();
    expect(metaGraphProvider({ META_LEADS_PROVIDER: "fake", VERCEL_ENV: "preview" })).toBeNull();
  });

  it("the fake reaches no network and answers by the ids", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const fake = createFakeGraphProvider();
    const t = "fake-1001-token";
    expect(await fake.fetchLead("123404", t, "1001")).toEqual({ ok: false, code: "not_found" });
    expect(await fake.fetchLead("123503", t, "1001")).toEqual({ ok: false, code: "graph_unavailable" });
    expect(await fake.fetchLead("1", "fake-invalid", "1001")).toEqual({ ok: false, code: "token_invalid" });
    const ok = await fake.fetchLead("1234567", t, "1001");
    expect(ok.ok && finishLeadFrom(ok.lead).email).toBe("lead1234567@example.test");
    expect(await fake.checkPage("1001", t)).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the contract of types.ts: a token proves only its own page (review finding 2)", async () => {
    const fake = createFakeGraphProvider();
    // the token's identity must be the page: a valid token of another page is refused, for the check and for a lead
    expect(await fake.checkPage("1001", "fake-2002-token")).toEqual({ ok: false, code: "token_invalid" });
    expect(await fake.checkPage("1001", "any-token-at-all")).toEqual({ ok: false, code: "token_invalid" });
    expect(await fake.fetchLead("1234567", "fake-2002-token", "1001")).toEqual({ ok: false, code: "token_invalid" });
    expect(await fake.checkPage("2002", "fake-2002-token")).toEqual({ ok: true });
  });

  it("a provider call ends within the timeout, answering the fallback (review finding 4)", async () => {
    vi.useFakeTimers();
    try {
      const slow = new Promise<string>(() => undefined);
      const pending = withTimeout(slow, "late", 10_000);
      vi.advanceTimersByTime(10_000);
      expect(await pending).toBe("late");
      expect(await withTimeout(Promise.reject(new Error("x")), "failed")).toBe("failed");
      expect(await withTimeout(Promise.resolve("on time"), "late")).toBe("on time");
      expect(PROVIDER_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CAP-11: the webhook route", () => {
  const keyText = randomBytes(32).toString("base64");
  const key = parseSecretKey(keyText)!;
  const deferred: (() => Promise<void>)[] = [];
  const settle = async () => {
    for (const work of deferred.splice(0)) await work();
  };
  const deps = (db: MetaLeadsDb | null, extra: Partial<MetaLeadsDeps> = {}) => {
    const factory = vi.fn(() => db);
    const deps: MetaLeadsDeps = {
      env: { META_APP_SECRET: SECRET, PUSH_DISPATCH_SECRET: "sweep" },
      db: factory,
      provider: createFakeGraphProvider(),
      keys: [key],
      // the deferred fetch runs when the test settles it (after the answer, as next/server's after)
      defer: (work) => {
        deferred.push(work);
      },
      ...extra,
    };
    return { factory, deps };
  };

  it("an invalid signature is refused before the database is reached, and the body is never logged", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    const body = webhookBody([{ lead: "77" }]).replace("}", ',"secret":"BODY-MARK-9137"}');
    const { factory, deps: d } = deps(fakeDb().db);
    for (const headers of [{}, { "x-hub-signature-256": sign(body, "wrong") }, { "x-hub-signature-256": "sha256=zz" }] as Record<string, string>[]) {
      const res = await webhookRoute(post(body, headers), d);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("BODY-MARK-9137");
    }
    expect(factory).not.toHaveBeenCalled();
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    // no App Secret: 503, still before the database
    const noSecret = await webhookRoute(post(body, { "x-hub-signature-256": sign(body) }), { ...d, env: {} });
    expect(noSecret.status).toBe(503);
    expect(factory).not.toHaveBeenCalled();
  });

  it("a body over the limit is refused before it is read in full or checked", async () => {
    const { factory, deps: d } = deps(fakeDb().db);
    const big = "x".repeat(256 * 1024 + 1);
    expect((await webhookRoute(post(big, { "x-hub-signature-256": sign(big) }), d)).status).toBe(413);
    expect(factory).not.toHaveBeenCalled();
  });

  it("a signed body records the ids, then fetches the new leads with the decrypted token", async () => {
    const token = "fake-1001-page-token";
    const envelope = encryptSecret(token, key, { organizationId: ORG, integrationId: CONN, externalId: "1001" });
    const claimed: Claimed[] = [{ arrival: "a1", lease: "l1", meta_lead_id: "1234567", organization_id: ORG, integration_id: CONN, page_id: "1001", ciphertext: envelope }];
    const { db, calls } = fakeDb({
      async claim(...args) {
        calls.push({ fn: "claim", args });
        return claimed;
      },
    });
    const provider = createFakeGraphProvider();
    const fetchLead = vi.spyOn(provider, "fetchLead");
    const { deps: d } = deps(db, { provider });
    const body = webhookBody([{ lead: "1234567" }]);
    const res = await webhookRoute(post(body, { "x-hub-signature-256": sign(body) }), d);
    expect(res.status).toBe(200);
    // review finding 4: Meta has its answer before anything is fetched
    expect(calls.map((c) => c.fn)).toEqual(["receive"]);
    await settle();
    expect(calls.map((c) => c.fn)).toEqual(["receive", "claim", "finish"]);
    expect(calls[0].args).toEqual(["1001", [{ id: "1234567", form_id: "2002" }]]);
    expect(calls[1].args).toEqual([5, ["a1"]]);
    expect(fetchLead).toHaveBeenCalledWith("1234567", token, "1001");
    const [arrival, lease, lead, error] = calls[2].args;
    expect([arrival, lease, error]).toEqual(["a1", "l1", null]);
    expect(lead).toMatchObject({ email: "lead1234567@example.test", platform: "ig" });
    // the token never reaches the database or the answer
    expect(JSON.stringify(calls)).not.toContain(token);
    expect(await res.text()).not.toContain(token);
  });

  it("a ciphertext that does not decrypt is reported as a code; without a provider nothing is claimed", async () => {
    const other = parseSecretKey(randomBytes(32).toString("base64"))!;
    const claimed: Claimed[] = [
      {
        arrival: "a1",
        lease: "l1",
        meta_lead_id: "5",
        organization_id: ORG,
        integration_id: CONN,
        page_id: "1001",
        ciphertext: encryptSecret("t", other, { organizationId: ORG, integrationId: CONN, externalId: "1001" }),
      },
    ];
    const { db, calls } = fakeDb({
      async claim() {
        return claimed;
      },
    });
    const body = webhookBody([{ lead: "5" }]);
    await webhookRoute(post(body, { "x-hub-signature-256": sign(body) }), deps(db).deps);
    await settle();
    expect(calls.find((c) => c.fn === "finish")?.args).toEqual(["a1", "l1", null, "secret_unreadable"]);

    const second = fakeDb();
    const res = await webhookRoute(post(body, { "x-hub-signature-256": sign(body) }), deps(second.db, { provider: null }).deps);
    expect(res.status).toBe(200);
    expect(second.calls.map((c) => c.fn)).toEqual(["receive"]);
  });

  it("a connection over its hourly limit answers 429 (Meta sends it again); a database failure 500", async () => {
    const body = webhookBody([{ lead: "5" }]);
    const limited = fakeDb({
      async receive() {
        return { status: "rate_limited", new: 0, arrivals: [] };
      },
    });
    expect((await webhookRoute(post(body, { "x-hub-signature-256": sign(body) }), deps(limited.db).deps)).status).toBe(429);
    const broken = fakeDb({
      async receive() {
        throw new Error("down");
      },
    });
    expect((await webhookRoute(post(body, { "x-hub-signature-256": sign(body) }), deps(broken.db).deps)).status).toBe(500);
  });

  it("the sweep needs the shared secret, a provider and the key", async () => {
    const { db, calls } = fakeDb();
    const sweep = (auth: string | null, extra: Partial<MetaLeadsDeps> = {}) =>
      sweepRoute(new Request("https://app.example/api/meta/leads/sweep", { method: "POST", headers: auth ? { authorization: auth } : {} }), deps(db, extra).deps);
    expect((await sweep(null)).status).toBe(401);
    expect((await sweep("Bearer wrong")).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await sweep("Bearer sweep", { provider: null })).status).toBe(503);
    expect((await sweep("Bearer sweep", { keys: [] })).status).toBe(503);
    expect(calls).toEqual([]);
    const res = await sweep("Bearer sweep");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: 0, ended: 0 });
    expect(calls.map((c) => c.fn)).toEqual(["claim"]);
  });
});
