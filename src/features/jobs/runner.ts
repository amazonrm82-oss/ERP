import { redactJobError, type ClaimedJob, type JobRegistry, parseClaimed } from "./registry";

/** What public.finish_job answered; null when the call itself failed. */
export type FinishAnswer = "done" | "failed" | "dead" | "released" | "stale" | null;

/** The two queue calls the runner makes (public.claim_jobs and public.finish_job, service_role only). */
export type QueueCalls = {
  claim(kinds: string[], limit: number): Promise<unknown>;
  finish(
    job: { id: string; lease: string },
    report: { ok: boolean; error: string | null; final: boolean; started: boolean },
  ): Promise<FinishAnswer>;
};

/**
 * unconfirmed = a job whose outcome the queue did not take (finish_job failed or answered stale): after a send this
 * means the message may go out again when the job is claimed again, so each one is logged.
 */
export type RunSummary = { claimed: number; done: number; failed: number; ended: number; released: number; unconfirmed: number };

/** One redacted line: the job id and the answer only, never the payload or an error text. */
export type RunLog = (line: string) => void;

const defaultLog: RunLog = (line) => console.error(line);

/**
 * Claims batches of the registered kinds and runs each job's handler, one job at a time, until the queue is empty or the
 * time budget is spent. Jobs claimed but not started when the budget runs out are handed back at once (finish_job with
 * started = false: queued again, the attempt not counted), so they never go dead untried. A handler that throws counts
 * as a failed try.
 */
export async function runJobs(
  calls: QueueCalls,
  registry: JobRegistry,
  options: { batch?: number; budgetMs?: number; now?: () => number; log?: RunLog } = {},
): Promise<RunSummary> {
  const summary: RunSummary = { claimed: 0, done: 0, failed: 0, ended: 0, released: 0, unconfirmed: 0 };
  if (registry.kinds.length === 0) return summary;
  const now = options.now ?? Date.now;
  const log = options.log ?? defaultLog;
  const deadline = now() + (options.budgetMs ?? 40_000);
  const batch = options.batch ?? 20;

  const report = async (job: ClaimedJob, ok: boolean, error: string | null, final: boolean, expected: FinishAnswer[], what: string) => {
    let answer: FinishAnswer;
    try {
      answer = await calls.finish(job, { ok, error, final, started: true });
    } catch {
      answer = null;
    }
    if (!expected.includes(answer)) {
      summary.unconfirmed += 1;
      log(`[jobs] ${what} not recorded: job ${job.id} kind ${job.kind} answer ${answer ?? "error"}`);
    }
  };

  while (now() < deadline) {
    const jobs = parseClaimed(await calls.claim(registry.kinds, batch));
    if (jobs.length === 0) break;
    summary.claimed += jobs.length;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (now() >= deadline) {
        for (const left of jobs.slice(i)) {
          let answer: FinishAnswer = null;
          try {
            answer = await calls.finish(left, { ok: false, error: null, final: false, started: false });
          } catch {
            answer = null;
          }
          if (answer === "released") summary.released += 1;
          else log(`[jobs] hand-back not recorded: job ${left.id} kind ${left.kind} answer ${answer ?? "error"}`);
        }
        return summary;
      }
      const handler = registry.handlerFor(job.kind);
      if (!handler) {
        await report(job, false, "no handler", false, ["failed", "dead"], "failure");
        summary.failed += 1;
        continue;
      }
      try {
        const outcome = await handler(job);
        if (outcome.status === "done") {
          summary.done += 1;
          await report(job, true, null, false, ["done"], "success after the work was done");
        } else if (outcome.status === "failed") {
          summary.failed += 1;
          await report(job, false, redactJobError(outcome.error), outcome.final === true, ["failed", "dead"], "failure");
        } else {
          summary.ended += 1;
        }
      } catch (error) {
        summary.failed += 1;
        await report(job, false, redactJobError(error), false, ["failed", "dead"], "failure");
      }
    }
    if (jobs.length < batch) break;
  }
  return summary;
}
