import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ClaimedJob } from "@/features/jobs/registry";
import { jobTimeLeftMs, JOBS_RUN_MAX_MS } from "@/features/jobs/run-server";
import { attachmentRefAllowed, downloadEmailAttachment, EMAIL_ATTACHMENT_BUCKET } from "@/features/messaging/email-attachments-server";
import {
  attachmentFilename,
  createResendProvider,
  emailHtml,
  plainEmailAddress,
  RESEND_SEND_URL,
  resendAccountReady,
  resendTimeoutMs,
  senderDisplayName,
} from "@/features/messaging/providers/resend";
import { messagingProviderFor } from "@/features/messaging/providers/select";
import type { LoadedEmail, OutgoingMessage } from "@/features/messaging/providers/types";
import { createSendHandler, EMAIL_ATTACHMENT_READS_MS, emailWorstCaseMs, handBackForTime, parseComposedEmail } from "@/features/messaging/send-handler";

vi.mock("server-only", () => ({}));

// EML-01 (owner (268) א): the Resend adapter, with a mocked fetch. Everything sent comes from the composer only.

const root = join(__dirname, "..", "..");
const ENV = { RESEND_API_KEY: "re_test_123", RESEND_FROM: "noreply@mexuz.test" };
const JOB = "11111111-1111-4111-8111-111111111111";
const ORG = "33333333-3333-4333-8333-333333333333";
const FILE = "66666666-6666-4666-8666-666666666666";

const email = (extra: Partial<LoadedEmail> = {}): LoadedEmail => ({
  to: "dana@example.com",
  fromName: "עסק \"הרכבה\" <x>",
  subject: "שלום דנה",
  text: "שלום https://phish.test/x דנה,\nהמסמך: https://mexuz.test/f/sign/abc.\n<b>",
  replyTo: "rep@example.com",
  listUnsubscribe: null,
  links: ["https://mexuz.test/f/sign/abc"],
  attachments: [],
  ...extra,
});
const message = (content?: LoadedEmail): OutgoingMessage => ({
  jobId: JOB,
  organizationId: ORG,
  channel: "email",
  messageType: "requested_document",
  purpose: "service",
  recordType: "lead",
  recordId: "r",
  ...(content ? { emailContent: content } : {}),
});
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("EML-01: the Resend adapter", () => {
  it("is no provider without its key and a plain sender address", () => {
    expect(createResendProvider({})).toBeNull();
    expect(createResendProvider({ RESEND_API_KEY: "re_x" })).toBeNull();
    expect(createResendProvider({ RESEND_API_KEY: "re_x", RESEND_FROM: "Mexuz <noreply@mexuz.test>" })).toBeNull();
    expect(createResendProvider({ RESEND_API_KEY: " ", RESEND_FROM: "noreply@mexuz.test" })).toBeNull();
    expect(resendAccountReady(ENV)).toBe(true);
    expect(messagingProviderFor("email", { MESSAGING_PROVIDER_EMAIL: "resend", ...ENV, VERCEL_ENV: "production" })?.name).toBe("resend");
    expect(messagingProviderFor("email", { MESSAGING_PROVIDER_EMAIL: "resend" })).toBeNull();
    expect(messagingProviderFor("sms", { MESSAGING_PROVIDER: "resend", ...ENV })).toBeNull();
  });

  it("posts one JSON email with the key, the job id as the idempotency key, the business name and the reply-to", async () => {
    const fetch = vi.fn(async () => answer({ id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }));
    const provider = createResendProvider(ENV, { fetch })!;
    expect(provider.composes).toBe(true);
    expect(provider.channel).toBe("email");
    const result = await provider.send(message(email({ attachments: [{ name: "חוזה\u202e/../x\u0000.pdf", type: "application/pdf", content: "JVBERi0=" }] })));
    expect(result).toEqual({ ok: true, providerId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_SEND_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_123");
    expect(headers["Idempotency-Key"]).toBe(JOB);
    const body = JSON.parse(String(init.body));
    expect(body.from).toBe('"עסק הרכבה x" <noreply@mexuz.test>');
    expect(body.to).toEqual(["dana@example.com"]);
    expect(body.subject).toBe("שלום דנה");
    expect(body.reply_to).toBe("rep@example.com");
    expect(body.headers).toBeUndefined();
    expect(body.attachments).toEqual([{ filename: "חוזה_.._x.pdf", content: "JVBERi0=", content_type: "application/pdf" }]);
    expect(body.html).toContain('<a href="https://mexuz.test/f/sign/abc">https://mexuz.test/f/sign/abc</a>.');
    // review finding 1: an address the composer did not put there (a customer's typed name) stays plain text
    expect(body.html).toContain("שלום https://phish.test/x דנה");
    expect(body.html).not.toContain('href="https://phish.test');
    expect(body.html).toContain("&lt;b&gt;");
    expect(body.html).toContain('dir="rtl"');
  });

  it("adds the one-click unsubscribe headers to a marketing email, and leaves out a reply-to that is not plain", async () => {
    const fetch = vi.fn(async () => answer({ id: "abc" }));
    await createResendProvider(ENV, { fetch })!.send(message(email({ replyTo: null, listUnsubscribe: "https://mexuz.test/api/forms/unsub/tok" })));
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.headers).toEqual({ "List-Unsubscribe": "<https://mexuz.test/api/forms/unsub/tok>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(body).not.toHaveProperty("reply_to");
    expect(body).not.toHaveProperty("attachments");
  });

  it("retries only a throttle and a failure before any connection; anything that may have gone out is unknown and final", async () => {
    const send = (response: Response | Error) =>
      createResendProvider(ENV, { fetch: async () => { if (response instanceof Error) throw response; return response; }, log: () => undefined })!.send(message(email()));
    await expect(send(answer({ message: "slow down" }, 429))).resolves.toEqual({ ok: false, error: "resend http_429", code: "http_429", final: false });
    await expect(send(answer({}, 401))).resolves.toMatchObject({ code: "key_refused", final: true, notSent: true });
    await expect(send(answer({ name: "validation_error" }, 422))).resolves.toMatchObject({ code: "http_422", final: true, notSent: true });
    await expect(send(answer({}, 409))).resolves.toEqual({ ok: false, error: "resend unknown_http_409", code: "unknown_http_409", final: true });
    await expect(send(answer({}, 500))).resolves.toMatchObject({ code: "unknown_http_500", final: true });
    expect((await send(answer({}, 502))).ok).toBe(false);
    const refused = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    await expect(send(refused)).resolves.toMatchObject({ code: "network", final: false, notSent: true });
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    await expect(send(timeout)).resolves.toEqual({ ok: false, error: "resend unknown_timeout", code: "unknown_timeout", final: true });
    await expect(send(new Error("reset"))).resolves.toMatchObject({ code: "unknown_network", final: true });
    // accepted but unreadable: sent (the job id stands for the provider id)
    await expect(send(new Response("not json", { status: 200 }))).resolves.toEqual({ ok: true, providerId: JOB });
  });

  it("never sends without the composer's content or to an address that is not plain", async () => {
    const fetch = vi.fn();
    const provider = createResendProvider(ENV, { fetch })!;
    await expect(provider.send(message())).resolves.toMatchObject({ code: "no_content", notSent: true });
    await expect(provider.send(message(email({ to: "a@b.com, c@d.com" })))).resolves.toMatchObject({ code: "bad_address", notSent: true, final: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks addresses and display names", () => {
    expect(plainEmailAddress("dana@example.co.il")).toBe(true);
    for (const bad of ["dana@example", "a b@c.com", "<a@b.com>", "a@b.com\r\nBcc: x@y.com", "\"a\"@b.com", "a@b.com;c@d.com", "", null]) {
      expect(plainEmailAddress(bad), String(bad)).toBe(false);
    }
    expect(senderDisplayName("א\r\nBcc: x")).toBe("א Bcc: x");
    expect(senderDisplayName("x".repeat(100))).toHaveLength(70);
    // C1 controls, separators, bidi / format characters and "@" never reach the From header
    expect(senderDisplayName("עסק\u0085\u2028\u202e\u200b@x")).toBe("עסק x");
    expect(emailHtml("a & b\nhttps://x.test/a?b=1&c=2)", ["https://x.test/a?b=1&c=2"])).toContain('<a href="https://x.test/a?b=1&amp;c=2">https://x.test/a?b=1&amp;c=2</a>)');
    // only exact, standalone occurrences of the listed https links; never http, never a longer URL that starts with one
    expect(emailHtml("http://x.test/a", ["http://x.test/a"])).not.toContain("<a ");
    expect(emailHtml("https://x.test/abc", ["https://x.test/a"])).not.toContain("<a ");
    expect(emailHtml("evil.https://x.test/a", ["https://x.test/a"])).not.toContain("<a ");
    expect(emailHtml("(https://x.test/a)", ["https://x.test/a"])).toContain('(<a href="https://x.test/a">');
    // delta review (3): right after ':' or a Hebrew letter it is clickable; the href is the exact listed URL
    expect(emailHtml("לחתימה:https://x.test/a", ["https://x.test/a"])).toContain(':<a href="https://x.test/a">');
    expect(emailHtml("בקישורhttps://x.test/a.", ["https://x.test/a"])).toContain('בקישור<a href="https://x.test/a">https://x.test/a</a>.');
    expect(emailHtml("x/https://x.test/a", ["https://x.test/a"])).not.toContain("<a ");
    expect(emailHtml("https://x.test/a https://x.test/a", ["https://x.test/a"]).match(/<a /g)).toHaveLength(2);
    expect(emailHtml("https://x.test/a")).not.toContain("<a ");
  });

  it("cleans attachment names and keeps their extension", () => {
    expect(attachmentFilename("הצעה.pdf")).toBe("הצעה.pdf");
    expect(attachmentFilename("a\u0001b\u202ec\u2029.PDF")).toBe("abc.PDF");
    expect(attachmentFilename("dir/sub\\name.docx")).toBe("dir_sub_name.docx");
    expect(attachmentFilename(`${"א".repeat(150)}.pdf`)).toBe(`${"א".repeat(100)}.pdf`);
    expect(attachmentFilename("\u200b.pdf")).toBe("file.pdf");
    expect(attachmentFilename("")).toBe("file");
    expect(attachmentFilename("noext")).toBe("noext");
  });

  it("gives a large request more time, within 40 seconds", async () => {
    expect(resendTimeoutMs(0)).toBe(10_000);
    expect(resendTimeoutMs(1)).toBe(12_000);
    expect(resendTimeoutMs(3 * 1_048_576)).toBe(16_000);
    expect(resendTimeoutMs(14 * 1_048_576)).toBe(38_000);
    expect(resendTimeoutMs(100 * 1_048_576)).toBe(40_000);
    const route = readFileSync(join(root, "src", "app", "api", "jobs", "run", "route.ts"), "utf8");
    expect(route).toMatch(/export const maxDuration = 180;/);
    expect(JOBS_RUN_MAX_MS).toBe(180_000);
  });

  it("only the adapter reads the Resend settings", () => {
    const names = ["RESEND_API_KEY", "RESEND_FROM"];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : []));
    const allowed = join(root, "src", "features", "messaging", "providers", "resend.ts");
    for (const file of walk(join(root, "src"))) {
      if (file === allowed) continue;
      const text = readFileSync(file, "utf8");
      for (const name of names) expect(text.includes(name), `${file} names ${name}`).toBe(false);
    }
    const lint = readFileSync(join(root, "eslint.config.mjs"), "utf8");
    expect(lint).toContain('const RESEND_ADAPTER = "src/features/messaging/providers/resend.ts"');
    expect(lint).toContain("MemberExpression[property.name=/^RESEND_/]");
  });
});

describe("EML-01: the files are read only at the composer's paths", () => {
  const ref = { bucket: "record-files", path: `${ORG}/${FILE}`, name: "a.pdf", type: "application/pdf" };

  it("allows only the record-files bucket and a path of the job's own business", () => {
    expect(EMAIL_ATTACHMENT_BUCKET).toBe("record-files");
    expect(attachmentRefAllowed(ref, ORG)).toBe(true);
    expect(attachmentRefAllowed({ ...ref, bucket: "avatars" }, ORG)).toBe(false);
    expect(attachmentRefAllowed(ref, "44444444-4444-4444-8444-444444444444")).toBe(false);
    expect(attachmentRefAllowed({ ...ref, path: `${ORG}/../x` }, ORG)).toBe(false);
  });

  it("downloads base64, and answers null on a refused path or a Storage error", async () => {
    const download = vi.fn(async () => ({ data: new Blob([Buffer.from("PDF")]), error: null }));
    const client = { storage: { from: vi.fn(() => ({ download })) } };
    expect(await downloadEmailAttachment(client, ref, ORG)).toBe(Buffer.from("PDF").toString("base64"));
    expect(client.storage.from).toHaveBeenCalledWith("record-files");
    expect(download).toHaveBeenCalledWith(`${ORG}/${FILE}`);
    expect(await downloadEmailAttachment(client, { ...ref, bucket: "job-files" }, ORG)).toBeNull();
    expect(download).toHaveBeenCalledTimes(1);
    const failing = { storage: { from: () => ({ download: async () => ({ data: null, error: new Error("x") }) }) } };
    expect(await downloadEmailAttachment(failing, ref, ORG)).toBeNull();
  });
});

describe("EML-01: the send handler asks the email composer for a composing provider", () => {
  const job: ClaimedJob = {
    id: JOB,
    lease: "22222222-2222-4222-8222-222222222222",
    kind: "message.send",
    organization_id: ORG,
    payload: { channel: "email", message_type: "requested_document", lead_id: "44444444-4444-4444-8444-444444444444", template_id: "55555555-5555-4555-8555-555555555555" },
    attempt: 1,
  };
  const composed = {
    to: "dana@example.com",
    from_name: "עסק",
    subject: "שלום",
    text: "גוף",
    reply_to: null,
    list_unsubscribe: null,
    links: ["https://mexuz.test/f/sign/x"],
    attachments: [{ bucket: "record-files", path: `${ORG}/${FILE}`, name: "a.pdf", type: "application/pdf" }],
  };

  it("hands the composed email with its files to the adapter after the send check", async () => {
    const send = vi.fn(async () => ({ ok: true as const, providerId: "x1" }));
    const order: string[] = [];
    const handler = createSendHandler({
      providerFor: () => ({ name: "resend", channel: "email", composes: true, send }),
      maySend: async () => (order.push("may"), { may_send: true }),
      composeEmail: async () => (order.push("compose"), composed),
      loadAttachment: async () => (order.push("load"), "QUJD"),
    });
    expect(await handler(job)).toEqual({ status: "done", receipt: { provider: "resend", providerMessageId: "x1" } });
    expect(order).toEqual(["may", "compose", "load"]);
    expect((send.mock.calls[0] as unknown as [OutgoingMessage])[0].emailContent).toEqual({
      to: "dana@example.com",
      fromName: "עסק",
      subject: "שלום",
      text: "גוף",
      replyTo: null,
      listUnsubscribe: null,
      links: ["https://mexuz.test/f/sign/x"],
      attachments: [{ name: "a.pdf", type: "application/pdf", content: "QUJD" }],
    });
  });

  it("a refusal ends the job with the code; a missing file is a retry; nothing is sent", async () => {
    const send = vi.fn();
    const base = { providerFor: () => ({ name: "resend", channel: "email" as const, composes: true, send }), maySend: async () => ({ may_send: true }), loadAttachment: async () => "QUJD" };
    expect(await createSendHandler({ ...base, composeEmail: async () => ({ refused: "attachment_changed" }) })(job)).toEqual({
      status: "failed",
      error: "refused attachment_changed",
      final: true,
      receipt: { provider: null, errorCode: "attachment_changed" },
    });
    expect(await createSendHandler({ ...base, composeEmail: async () => ({ refused: "paused" }) })(job)).toEqual({ status: "failed", error: "waiting paused" });
    expect(await createSendHandler({ ...base, composeEmail: async () => ({ refused: "stale" }) })(job)).toEqual({ status: "failed", error: "stale lease" });
    expect(await createSendHandler({ ...base, composeEmail: async () => composed, loadAttachment: async () => null })(job)).toEqual({ status: "failed", error: "attachment unavailable" });
    expect(await createSendHandler({ ...base, composeEmail: async () => ({ ...composed, to: "x" }) })(job)).toEqual({ status: "failed", error: "composer answered nothing" });
    expect(send).not.toHaveBeenCalled();
  });

  it("hands an email back uncounted, before the send check, when its worst case does not fit (delta review (1))", async () => {
    expect(emailWorstCaseMs(0, 12_000)).toBe(22_000);
    expect(emailWorstCaseMs(2, 40_000)).toBe(80_000);
    expect(handBackForTime(79_999, 80_000)).toBe(true);
    expect(handBackForTime(80_000, 80_000)).toBe(false);
    expect(handBackForTime(null, 80_000)).toBe(false);
    // the lesser of the lease (120 s from the claim) and the run (180 s from the route's start)
    expect(jobTimeLeftMs(1_000, 0, 0)).toBe(119_000);
    expect(jobTimeLeftMs(150_000, 100_000, 0)).toBe(30_000);
    expect(jobTimeLeftMs(50_000, 45_000, 0)).toBe(115_000);
    const provider = createResendProvider(ENV, { fetch: vi.fn() })!;
    expect(provider.worstCaseMs?.(0)).toBe(12_000);
    expect(provider.worstCaseMs?.(3)).toBe(40_000);

    const maySend = vi.fn(async () => ({ may_send: true }));
    const composeEmail = vi.fn(async () => composed);
    const send = vi.fn(async () => ({ ok: true as const, providerId: "x" }));
    const base = { providerFor: () => ({ name: "resend", channel: "email" as const, composes: true, worstCaseMs: provider.worstCaseMs, send }), maySend, composeEmail, loadAttachment: async () => "QUJD" };
    const withFiles: ClaimedJob = { ...job, payload: { ...job.payload, file_ids: ["66666666-6666-4666-8666-666666666666"] } };
    expect(await createSendHandler({ ...base, timeLeftMs: () => 79_000 })(withFiles)).toEqual({ status: "yield" });
    expect(maySend).not.toHaveBeenCalled();
    expect(composeEmail).not.toHaveBeenCalled();
    // without files the same time is enough
    expect(await createSendHandler({ ...base, timeLeftMs: () => 79_000 })(job)).toMatchObject({ status: "done" });
    expect(await createSendHandler({ ...base, timeLeftMs: () => 80_000 })(withFiles)).toMatchObject({ status: "done" });
    expect(await createSendHandler({ ...base, timeLeftMs: () => 21_000 })(job)).toEqual({ status: "yield" });
  });

  it("reads every file of an email within 30 seconds together", async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const twoFiles = { ...composed, attachments: [composed.attachments[0], { ...composed.attachments[0], name: "b.pdf" }] };
    const handler = createSendHandler({
      providerFor: () => ({ name: "resend", channel: "email", composes: true, send: async () => ({ ok: true as const, providerId: "x" }) }),
      maySend: async () => ({ may_send: true }),
      composeEmail: async () => twoFiles,
      now: () => clock,
      loadAttachment: async (_ref, _job, timeoutMs) => {
        timeouts.push(timeoutMs);
        clock += 20_000;
        return "QUJD";
      },
    });
    expect(await handler(job)).toMatchObject({ status: "done" });
    expect(timeouts).toEqual([EMAIL_ATTACHMENT_READS_MS, 10_000]);
    timeouts.length = 0;
    clock = 0;
    const slow = createSendHandler({
      providerFor: () => ({ name: "resend", channel: "email", composes: true, send: async () => ({ ok: true as const, providerId: "x" }) }),
      maySend: async () => ({ may_send: true }),
      composeEmail: async () => twoFiles,
      now: () => clock,
      loadAttachment: async () => {
        clock += 30_000;
        return "QUJD";
      },
    });
    expect(await slow(job)).toEqual({ status: "failed", error: "attachment unavailable" });
  });

  it("owner (7) ב: a refused key (401/403) ends the job at once, not sent, with one error line of ids only", async () => {
    for (const status of [401, 403]) {
      const log = vi.fn();
      const result = await createResendProvider(ENV, { fetch: async () => answer({ message: "API key is invalid" }, status), log })!.send(message(email()));
      expect(result).toEqual({ ok: false, error: "resend key_refused", code: "key_refused", final: true, notSent: true });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("error", "email.key_refused", { job_id: JOB, org_id: ORG, status: `http_${status}` });
      const line = JSON.stringify(log.mock.calls);
      for (const secret of ["re_test_123", "dana@example.com", "noreply@mexuz.test", "שלום"]) expect(line).not.toContain(secret);
    }
    // a temporary failure is unchanged: a throttle is tried again, a 5xx ends unknown (it may have been sent), no key line
    const log = vi.fn();
    await expect(createResendProvider(ENV, { fetch: async () => answer({}, 429), log })!.send(message(email()))).resolves.toMatchObject({ code: "http_429", final: false });
    await expect(createResendProvider(ENV, { fetch: async () => answer({}, 503), log })!.send(message(email()))).resolves.toMatchObject({ code: "unknown_http_503", final: true });
    expect(log).not.toHaveBeenCalled();
  });

  it("gives the email count back for a refused key, once, and the job ends final with the code", async () => {
    const returnEmailQuota = vi.fn(async () => ({ returned: true }));
    const refused = { ok: false as const, error: "resend key_refused", code: "key_refused", final: true, notSent: true };
    const outcome = await createSendHandler({
      maySend: async () => ({ may_send: true }),
      composeEmail: async () => ({ ...composed, attachments: [] }),
      loadAttachment: async () => "x",
      returnEmailQuota,
      providerFor: () => ({ name: "resend", channel: "email", composes: true, send: async () => refused }),
    })(job);
    expect(returnEmailQuota).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "failed", final: true, receipt: { provider: "resend", errorCode: "key_refused" } });
  });

  it("gives the email count back only for a message that never reached Resend", async () => {
    const returnEmailQuota = vi.fn(async () => ({ returned: true }));
    const base = { maySend: async () => ({ may_send: true }), composeEmail: async () => ({ ...composed, attachments: [] }), loadAttachment: async () => "x", returnEmailQuota };
    const never = { ok: false as const, error: "e", code: "network", final: false, notSent: true };
    await createSendHandler({ ...base, providerFor: () => ({ name: "resend", channel: "email", composes: true, send: async () => never }) })(job);
    expect(returnEmailQuota).toHaveBeenCalledTimes(1);
    const maybe = { ok: false as const, error: "e", code: "unknown_timeout", final: true };
    await createSendHandler({ ...base, providerFor: () => ({ name: "resend", channel: "email", composes: true, send: async () => maybe }) })(job);
    expect(returnEmailQuota).toHaveBeenCalledTimes(1);
  });

  it("parses the composer's answer strictly", () => {
    expect(parseComposedEmail(composed)).toMatchObject({ ok: true });
    expect(parseComposedEmail({ refused: "bad code!" })).toBeNull();
    expect(parseComposedEmail({ ...composed, subject: "a\nBcc: x" })).toBeNull();
    expect(parseComposedEmail({ ...composed, reply_to: "a@b.com, c@d.com" })).toBeNull();
    expect(parseComposedEmail({ ...composed, attachments: [{ ...composed.attachments[0], bucket: "avatars" }] })).toBeNull();
    expect(parseComposedEmail({ ...composed, attachments: [{ ...composed.attachments[0], path: "../x" }] })).toBeNull();
    expect(parseComposedEmail({ ...composed, attachments: Array(6).fill(composed.attachments[0]) })).toBeNull();
    expect(parseComposedEmail({ ...composed, list_unsubscribe: "javascript:x" })).toBeNull();
    // delta review (2): a bad link is left out (plain text), never a failed answer
    expect(parseComposedEmail({ ...composed, links: ["http://mexuz.test/x", "https://a.test/x'y", "https://a.test/x y", 5, "https://ok.test/a"] })).toMatchObject({
      ok: true,
      content: { links: ["https://ok.test/a"] },
    });
    expect(parseComposedEmail({ ...composed, links: undefined })).toMatchObject({ ok: true, content: { links: [] } });
    expect(parseComposedEmail(null)).toBeNull();
  });
});
