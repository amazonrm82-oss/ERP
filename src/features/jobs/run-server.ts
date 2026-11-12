import "server-only";

import { createExportHandler, createImportHandler, type BackgroundCalls } from "@/features/background/handlers";
import { BACKGROUND_RUN_BUDGET_MS } from "@/features/background/rules";
import { backgroundJobsReady, createBackgroundTokenSource, createUserClient } from "@/features/background/user-token";
import { AGREEMENT_VERSION } from "@/features/legal/agreement";
import { createSendHandler } from "@/features/messaging/send-handler";
import { messagingProviders } from "@/features/messaging/providers/select";
import { logEvent } from "@/lib/log";
import { requestIdOf } from "@/lib/request-id";
import { bearerSecretMatches } from "@/lib/shared-secret";
import { createServiceClient } from "@/lib/supabase/service";

import { createRegistry, type ClaimedJob } from "./registry";
import { runJobs, type QueueCalls, type RunLog, type RunSummary } from "./runner";

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// SMS-05: the app's own origin, for the links an SMS carries (the composer refuses a text that needs one without it)
const siteOrigin = () => process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") ?? "";

// IMP-04: a background job holds its claim this long (it hands the job back at BACKGROUND_RUN_BUDGET_MS)
const BACKGROUND_LEASE_SECONDS = 900;

/**
 * The background job worker (OPS-04), route POST /api/jobs/run. Called by the database (app.wake_job_worker, through
 * pg_net, every minute while work is due), never by a user: it carries the push dispatcher's shared secret, checked
 * timing-safe before anything else. With the service role it calls only public.claim_jobs(), public.finish_job() and,
 * for message.send, public.job_message_may_send() and, for a composing SMS provider (InforU, SMS-05), public.sms_job_compose() and public.sms_quota_return() (owner (326) ב); for import.run and export.run (IMP-04, owner (155) א, (160) א) only
 * public.background_job_begin(), background_job_progress() and background_job_end(), and, through the token source it hands
 * this client to (src/features/background/user-token.ts), background_job_token() before every signing of the person's token. No table is read or written with
 * the service role (CLAUDE.md hard rule 5, wave 3 use (1)): a background job's own work is done with a short-lived token
 * of the person who ordered it (src/features/background/user-token.ts), made only from the claims begin answered.
 * Only kinds with a ready handler are claimed: message.send only with a provider configured for a channel, the two
 * background kinds only when the signer is set up (backgroundJobsReady).
 */
export async function runJobsRoute(request: Request): Promise<Response> {
  const secret = process.env.PUSH_DISPATCH_SECRET?.trim();
  if (!secret) return json(503, { error: "jobs are not configured" });
  if (!bearerSecretMatches(request.headers.get("authorization"), secret)) return json(401, { error: "unauthorized" });
  const supabase = createServiceClient();
  if (!supabase) return json(503, { error: "jobs are not configured" });

  // MSG-01: one provider per channel; message.send is registered while any channel has one
  const providers = messagingProviders();
  const registry = createRegistry({
    "message.send": Object.keys(providers).length > 0
      ? createSendHandler({
          providerFor: (channel) => providers[channel] ?? null,
          maySend: async (job) => {
            const { data, error } = await supabase.rpc("job_message_may_send", { p_job: job.id, p_lease: job.lease });
            if (error) throw new Error("send check failed");
            return data;
          },
          // SMS-05: the InforU sender's text, number and sender (service_role, the live lease only)
          compose: async (job) => {
            const { data, error } = await supabase.rpc("sms_job_compose", { p_job: job.id, p_lease: job.lease, p_site_url: siteOrigin() });
            if (error) throw new Error("compose failed");
            return data;
          },
          // owner (326) ב: an SMS the adapter never got to InforU gives its count back (the live lease only)
          returnQuota: async (job) => {
            const { data, error } = await supabase.rpc("sms_quota_return", { p_job: job.id, p_lease: job.lease });
            if (error) throw new Error("quota return failed");
            return data;
          },
        })
      : null,
  });

  // IMP-04: the background kinds, claimed in their own pass with a longer lease, one job at a time
  const background: BackgroundCalls = {
    begin: async (job: ClaimedJob) => {
      // review 5: the app's current legal version, which the person must have signed
      const { data, error } = await supabase.rpc("background_job_begin", { p_job: job.id, p_lease: job.lease, p_legal_version: AGREEMENT_VERSION });
      if (error) throw new Error("begin failed");
      return data;
    },
    progress: async (job, importJobId, rowsDone, counts) => {
      const { data, error } = await supabase.rpc("background_job_progress", {
        p_job: job.id,
        p_lease: job.lease,
        ...(importJobId ? { p_import_job: importJobId } : {}),
        p_rows_done: rowsDone,
        p_counts: counts,
      });
      return error ? null : (data as string | null);
    },
    end: async (job, ok, counts, message, filePath) => {
      const { data, error } = await supabase.rpc("background_job_end", {
        p_job: job.id,
        p_lease: job.lease,
        p_ok: ok,
        p_counts: counts ?? undefined,
        p_message: message ?? undefined,
        p_file_path: filePath ?? undefined,
      });
      return error ? null : (data as string | null);
    },
  };
  const ready = backgroundJobsReady();
  const backgroundRegistry = createRegistry({
    // the token source asks public.background_job_token itself (this client, this job, this lease) before every signing
    "import.run": ready ? createImportHandler({ calls: background, tokenSource: (job) => createBackgroundTokenSource(supabase, job), userClient: createUserClient }) : null,
    "export.run": ready ? createExportHandler({ calls: background, tokenSource: (job) => createBackgroundTokenSource(supabase, job), userClient: createUserClient }) : null,
  });

  const calls = (leaseSeconds: number | undefined, channels: string[] | undefined): QueueCalls => ({
    claim: async (kinds, limit) => {
      // MSG-01: only messages of a channel with a provider are claimed; the others wait in the queue, uncounted
      const { data, error } = await supabase.rpc("claim_jobs", {
        p_kinds: kinds,
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
        p_channels: channels,
      });
      if (error) throw new Error("claim failed");
      return data;
    },
    finish: async (job, report) => {
      const { data, error } = await supabase.rpc("finish_job", {
        p_job: job.id,
        p_lease: job.lease,
        p_ok: report.ok,
        p_error: report.error ?? undefined,
        p_final: report.final,
        p_started: report.started,
        // MSG-03: the provider's receipt, kept on the job; the database records the message when the job ends
        p_provider: report.receipt?.provider ?? undefined,
        p_provider_message_id: report.receipt?.providerMessageId,
        p_provider_error_code: report.receipt?.errorCode,
      });
      if (error) return null;
      return data === "done" || data === "failed" || data === "dead" || data === "released" || data === "stale" ? data : null;
    },
  });

  try {
    const startedAt = Date.now();
    // OPS-06: the run's lines carry the request id the proxy set
    const requestId = requestIdOf(request.headers);
    const log: RunLog = (entry) => logEvent("error", "jobs.finish_not_recorded", { ...entry, request_id: requestId });
    const messages = await runJobs(calls(undefined, Object.keys(providers)), registry, { log });
    // what the messages left of the run's time; a background job that does not fit waits for the next run
    const left = 50_000 - (Date.now() - startedAt);
    const jobs: RunSummary =
      left > 5_000 && backgroundRegistry.kinds.length > 0
        ? await runJobs(calls(BACKGROUND_LEASE_SECONDS, undefined), backgroundRegistry, { batch: 1, budgetMs: Math.min(left, BACKGROUND_RUN_BUDGET_MS), log })
        : { claimed: 0, done: 0, failed: 0, ended: 0, released: 0, unconfirmed: 0 };
    const summary: RunSummary = {
      claimed: messages.claimed + jobs.claimed,
      done: messages.done + jobs.done,
      failed: messages.failed + jobs.failed,
      ended: messages.ended + jobs.ended,
      released: messages.released + jobs.released,
      unconfirmed: messages.unconfirmed + jobs.unconfirmed,
    };
    return json(200, summary);
  } catch {
    return json(500, { error: "run failed" });
  }
}
