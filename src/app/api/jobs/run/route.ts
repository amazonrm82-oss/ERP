import { runJobsRoute } from "@/features/jobs/run-server";

// EML-01 delta review (1): the message pass starts no job after 40 s (runner.ts) and one email may take up to 80 s
// (30 s of file reads, a 40 s upload, a 10 s margin; send-handler.ts emailWorstCaseMs); the background pass ends by 50 s.
// 180 s covers a job started at the last moment; an email that would not fit in what is left of the run or of its lease
// is handed back uncounted before its send check (JOBS_RUN_MAX_MS in run-server.ts equals this value, unit test).
// Nothing else on the route reads it.
export const maxDuration = 180;

// OPS-04: woken by the database every minute while background work is due. Secret in the Authorization header.
export async function POST(request: Request) {
  return runJobsRoute(request);
}
