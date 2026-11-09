import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaimedJob } from "@/features/jobs/registry";
import { clearFakeSentMessages, createFakeProvider, fakeSentMessages } from "@/features/messaging/providers/fake";
import { messagingProviderFor, messagingProviders, providerEnvKey } from "@/features/messaging/providers/select";
import { MESSAGE_CHANNELS, MESSAGE_TYPES, messagePurpose, SERVICE_MESSAGE_TYPES } from "@/features/messaging/providers/types";
import { createSendHandler } from "@/features/messaging/send-handler";

const root = join(__dirname, "..", "..");

const job = (payload: Record<string, unknown>): ClaimedJob => ({
  id: "11111111-1111-4111-8111-111111111111",
  lease: "22222222-2222-4222-8222-222222222222",
  kind: "message.send",
  organization_id: "33333333-3333-4333-8333-333333333333",
  payload,
  attempt: 1,
});

describe("MSG-01: a provider per channel", () => {
  it("names one env variable per channel", () => {
    expect(MESSAGE_CHANNELS.map(providerEnvKey)).toEqual(["MESSAGING_PROVIDER_EMAIL", "MESSAGING_PROVIDER_SMS", "MESSAGING_PROVIDER_WHATSAPP"]);
  });

  it("takes the channel's own variable first, then MESSAGING_PROVIDER for every channel", () => {
    expect(messagingProviders({})).toEqual({});
    const all = messagingProviders({ MESSAGING_PROVIDER: "fake" });
    expect(Object.keys(all)).toEqual(["email", "sms", "whatsapp"]);
    for (const channel of MESSAGE_CHANNELS) expect(all[channel]).toMatchObject({ name: "fake", channel });

    const smsOnly = messagingProviders({ MESSAGING_PROVIDER_SMS: "fake" });
    expect(Object.keys(smsOnly)).toEqual(["sms"]);
    // a channel's own unknown code wins over the general one: that channel has no provider
    const mixed = messagingProviders({ MESSAGING_PROVIDER: "fake", MESSAGING_PROVIDER_WHATSAPP: "someone" });
    expect(Object.keys(mixed)).toEqual(["email", "sms"]);
    // empty or spaces = not set
    expect(messagingProviderFor("email", { MESSAGING_PROVIDER_EMAIL: "  ", MESSAGING_PROVIDER: "fake" })?.name).toBe("fake");
  });

  it("knows only the fake adapter, and never a code from the object prototype", () => {
    for (const name of ["real", "sendgrid", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(messagingProviderFor("sms", { MESSAGING_PROVIDER: name }), name).toBeNull();
    }
    expect(messagingProviderFor("sms", { MESSAGING_PROVIDER: "FAKE" })?.name).toBe("fake");
  });

  it("refuses the fake on a Vercel production or preview deployment, per channel too", () => {
    for (const vercel of ["production", "preview"]) {
      expect(messagingProviders({ MESSAGING_PROVIDER: "fake", VERCEL_ENV: vercel })).toEqual({});
      expect(messagingProviders({ MESSAGING_PROVIDER_EMAIL: "fake", VERCEL_ENV: vercel })).toEqual({});
    }
    expect(Object.keys(messagingProviders({ MESSAGING_PROVIDER_EMAIL: "fake", VERCEL_ENV: "development" }))).toEqual(["email"]);
  });
});

describe("MSG-01: the send handler uses the job's channel's provider", () => {
  beforeEach(() => clearFakeSentMessages());

  it("sends through the channel's provider only", async () => {
    const providers = messagingProviders({ MESSAGING_PROVIDER_SMS: "fake" });
    const maySend = vi.fn(async () => ({ may_send: true }));
    const handler = createSendHandler({ maySend, providerFor: (channel) => providers[channel] ?? null });
    const sms = await handler(job({ channel: "sms", lead_id: "44444444-4444-4444-8444-444444444444" }));
    expect(sms.status).toBe("done");
    // email has no provider: a failed try, and the database is not asked (nothing checked or recorded)
    const email = await handler(job({ channel: "email", lead_id: "44444444-4444-4444-8444-444444444444" }));
    expect(email).toEqual({ status: "failed", error: "no provider for channel" });
    expect(maySend).toHaveBeenCalledTimes(1);
    expect(fakeSentMessages().map((m) => m.channel)).toEqual(["sms"]);
  });

  it("never hands a job to a provider of another channel", async () => {
    const maySend = vi.fn(async () => ({ may_send: true }));
    const handler = createSendHandler({ maySend, providerFor: () => createFakeProvider({ channel: "email" }) });
    expect(await handler(job({ channel: "whatsapp", contact_id: "55555555-5555-4555-8555-555555555555" }))).toEqual({
      status: "failed",
      error: "no provider for channel",
    });
    expect(maySend).not.toHaveBeenCalled();
    expect(fakeSentMessages()).toEqual([]);
  });

  it("no module outside the provider layer names an adapter", () => {
    for (const path of ["src/features/messaging/send-handler.ts", "src/features/jobs/run-server.ts"]) {
      expect(readFileSync(join(root, path), "utf8"), path).not.toMatch(/createFakeProvider|["']fake["']/);
    }
  });
});

describe("MSG-01: the worker asks only for channels with a provider", () => {
  it("passes the configured channels to claim_jobs", () => {
    const code = readFileSync(join(root, "src/features/jobs/run-server.ts"), "utf8");
    // IMP-04: the messages' pass claims with the channels of a provider; the background pass claims no message kind
    expect(code).toMatch(/rpc\("claim_jobs", \{[^}]*p_channels: channels/);
    expect(code).toMatch(/runJobs\(calls\(undefined, Object\.keys\(providers\)\), registry\)/);
  });
});

describe("MSG-03: the provider's receipt reaches the queue", () => {
  const lead = "44444444-4444-4444-8444-444444444444";

  it("a sent message carries the provider's code and its id; a failure its code and error code; never a cost", async () => {
    const provider = { ...createFakeProvider({ channel: "sms" }), send: async () => ({ ok: true as const, providerId: "p-1" }) };
    const handler = createSendHandler({ maySend: async () => ({ may_send: true }), providerFor: () => provider });
    expect(await handler(job({ channel: "sms", lead_id: lead }))).toEqual({ status: "done", receipt: { provider: "fake", providerMessageId: "p-1" } });
    const failing = { ...provider, send: async () => ({ ok: false as const, error: "rejected", final: true, code: "E.21" }) };
    const h = createSendHandler({ maySend: async () => ({ may_send: true }), providerFor: () => failing });
    expect(await h(job({ channel: "sms", lead_id: lead }))).toEqual({
      status: "failed",
      error: "rejected",
      final: true,
      receipt: { provider: "fake", errorCode: "E.21" },
    });
    const bare = { ...provider, send: async () => ({ ok: false as const, error: "down" }) };
    const hb = createSendHandler({ maySend: async () => ({ may_send: true }), providerFor: () => bare });
    expect(await hb(job({ channel: "sms", lead_id: lead }))).toEqual({ status: "failed", error: "down", final: undefined, receipt: { provider: "fake" } });
  });

  it("the runner passes the receipt to finish_job, on success and on failure", async () => {
    const { runJobs } = await import("@/features/jobs/runner");
    const { createRegistry } = await import("@/features/jobs/registry");
    const reports: unknown[] = [];
    const sent = { provider: "fake", providerMessageId: "p-9" };
    const failed = { provider: "fake", errorCode: "E1" };
    const outcomes = [
      { status: "done" as const, receipt: sent },
      { status: "failed" as const, error: "x", final: true, receipt: failed },
    ];
    let n = 0;
    await runJobs(
      {
        claim: async () => (n++ === 0 ? [job({ channel: "sms", lead_id: lead }), { ...job({ channel: "sms", lead_id: lead }), id: "j2" }] : []),
        finish: async (_job, report) => {
          reports.push(report);
          return report.ok ? "done" : "dead";
        },
      },
      createRegistry({ "message.send": async () => outcomes.shift() ?? { status: "done" } }),
      { log: () => {} },
    );
    expect(reports).toEqual([
      { ok: true, error: null, final: false, started: true, receipt: sent },
      { ok: false, error: "x", final: true, started: true, receipt: failed },
    ]);
  });

  it("the worker passes the provider's code, message id and error code, and no cost", () => {
    const code = readFileSync(join(root, "src/features/jobs/run-server.ts"), "utf8");
    expect(code).toContain("p_provider_error_code: report.receipt?.errorCode");
    expect(code).not.toMatch(/cost/i);
  });
});


describe("CNS-07: a closed list of message types; service is a closed list too", () => {
  beforeEach(() => clearFakeSentMessages());
  const lead = "44444444-4444-4444-8444-444444444444";

  it("hands the type and its purpose to the provider; none = marketing; an unknown type is never sent", async () => {
    const maySend = vi.fn(async () => ({ may_send: true }));
    const handler = createSendHandler({ maySend, providerFor: (channel) => createFakeProvider({ channel }) });
    for (const type of [...MESSAGE_TYPES]) await handler(job({ channel: "sms", lead_id: lead, message_type: type }));
    await handler(job({ channel: "sms", lead_id: lead }));
    expect(fakeSentMessages().map((m) => [m.messageType, m.purpose])).toEqual([
      ["meeting_reminder", "service"],
      ["requested_document", "service"],
      ["collection", "service"],
      ["verification_code", "service"],
      // PKG-03 (owner (127) ב)
      ["punch_card_notice", "service"],
      ["marketing", "marketing"],
      [null, "marketing"],
    ]);
    for (const bad of ["service", "promo", 1]) {
      expect(await handler(job({ channel: "sms", lead_id: lead, message_type: bad }))).toEqual({ status: "failed", error: "payload", final: true });
    }
    expect(maySend).toHaveBeenCalledTimes(7);
  });

  it("the types and the service list mirror the migration", () => {
    const dir = join(root, "supabase/migrations");
    // the latest migration that redefines the lists (PKG-03 added punch_card_notice)
    const file = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("create or replace function app.service_message_types()"))
      .pop() as string;
    const sql = readFileSync(join(dir, file), "utf8");
    const list = (name: string) => {
      const m = sql.match(new RegExp(`function app\\.${name}\\(\\)[\\s\\S]*?array\\[([^\\]]*)\\]`));
      expect(m, name).not.toBeNull();
      return [...(m as RegExpMatchArray)[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    };
    expect(list("message_types")).toEqual([...MESSAGE_TYPES]);
    expect(list("service_message_types")).toEqual([...SERVICE_MESSAGE_TYPES]);
    expect(SERVICE_MESSAGE_TYPES.every((t) => (MESSAGE_TYPES as readonly string[]).includes(t))).toBe(true);
    for (const t of MESSAGE_TYPES) expect(messagePurpose(t), t).toBe((SERVICE_MESSAGE_TYPES as readonly string[]).includes(t) ? "service" : "marketing");
    expect(messagePurpose(null)).toBe("marketing");
  });
});
