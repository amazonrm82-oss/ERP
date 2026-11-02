import { redactJobError, type JobRegistry, parseClaimed } from "./registry";

/** The two queue calls the runner makes (public.claim_jobs and public.finish_job, service_role only). */
export type QueueCalls = {
  claim(kinds: string[], limit: number): Promise<unknown>;
  finish(job: { id: string; lease: string }, ok: boolean, error: string | null, final: boolean): Promise<void>;
};

export type RunSummary = { claimed: number; done: number; failed: number; ended: number };

/**
 * Claims batches of the registered kinds and runs each job's handler, one job at a time, until the queue is empty or the
 * time budget is spent (a job claimed but not started keeps its lease and is claimed again when it runs out). A handler
 * that throws counts as a failed try.
 */
export async function runJobs(
  calls: QueueCalls,
  registry: JobRegistry,
  options: { batch?: number; budgetMs?: number; now?: () => number } = {},
): Promise<RunSummary> {
  const summary: RunSummary = { claimed: 0, done: 0, failed: 0, ended: 0 };
  if (registry.kinds.length === 0) return summary;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? 40_000);
  const batch = options.batch ?? 20;
  while (now() < deadline) {
    const jobs = parseClaimed(await calls.claim(registry.kinds, batch));
    if (jobs.length === 0) break;
    summary.claimed += jobs.length;
    for (const job of jobs) {
      if (now() >= deadline) return summary;
      const handler = registry.handlerFor(job.kind);
      if (!handler) {
        await calls.finish(job, false, "no handler", false);
        summary.failed += 1;
        continue;
      }
      try {
        const outcome = await handler(job);
        if (outcome.status === "done") {
          await calls.finish(job, true, null, false);
          summary.done += 1;
        } else if (outcome.status === "failed") {
          await calls.finish(job, false, redactJobError(outcome.error), outcome.final === true);
          summary.failed += 1;
        } else {
          summary.ended += 1;
        }
      } catch (error) {
        await calls.finish(job, false, redactJobError(error), false);
        summary.failed += 1;
      }
    }
    if (jobs.length < batch) break;
  }
  return summary;
}
