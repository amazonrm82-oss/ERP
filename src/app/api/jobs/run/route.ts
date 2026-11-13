import { runJobsRoute } from "@/features/jobs/run-server";

// EML-01 review (finding 2): the message pass starts no job after 40 s (runner.ts), and one email with attachments may take
// up to 40 s to upload (resendTimeoutMs) after up to 15 s per file read (email-attachments-server.ts); the function's limit
// covers that and stays within the jobs' 120 s lease (claim_jobs' default).
export const maxDuration = 120;

// OPS-04: woken by the database every minute while background work is due. Secret in the Authorization header.
export async function POST(request: Request) {
  return runJobsRoute(request);
}
