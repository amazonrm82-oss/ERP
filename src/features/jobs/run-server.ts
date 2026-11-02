import "server-only";

import { createSendHandler } from "@/features/messaging/send-handler";
import { messagingProvider } from "@/features/messaging/providers/select";
import { bearerSecretMatches } from "@/lib/shared-secret";
import { createServiceClient } from "@/lib/supabase/service";

import { createRegistry } from "./registry";
import { runJobs } from "./runner";

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * The background job worker (OPS-04), route POST /api/jobs/run. Called by the database (app.wake_job_worker, through
 * pg_net, every minute while work is due), never by a user: it carries the push dispatcher's shared secret, checked
 * timing-safe before anything else. With the service role it calls only public.claim_jobs(), public.finish_job() and,
 * for message.send, public.job_message_may_send(); no table is read or written directly (CLAUDE.md hard rule 5, wave 3
 * use (1)). Only kinds with a ready handler are claimed: today message.send, and only with a provider configured.
 */
export async function runJobsRoute(request: Request): Promise<Response> {
  const secret = process.env.PUSH_DISPATCH_SECRET?.trim();
  if (!secret) return json(503, { error: "jobs are not configured" });
  if (!bearerSecretMatches(request.headers.get("authorization"), secret)) return json(401, { error: "unauthorized" });
  const supabase = createServiceClient();
  if (!supabase) return json(503, { error: "jobs are not configured" });

  const provider = messagingProvider();
  const registry = createRegistry({
    "message.send": provider
      ? createSendHandler({
          provider,
          maySend: async (job) => {
            const { data, error } = await supabase.rpc("job_message_may_send", { p_job: job.id, p_lease: job.lease });
            if (error) throw new Error("send check failed");
            return data;
          },
        })
      : null,
  });

  try {
    const summary = await runJobs(
      {
        claim: async (kinds, limit) => {
          const { data, error } = await supabase.rpc("claim_jobs", { p_kinds: kinds, p_limit: limit });
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
          });
          if (error) return null;
          return data === "done" || data === "failed" || data === "dead" || data === "released" || data === "stale" ? data : null;
        },
      },
      registry,
    );
    return json(200, summary);
  } catch {
    return json(500, { error: "run failed" });
  }
}
