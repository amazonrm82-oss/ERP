import { runJobsRoute } from "@/features/jobs/run-server";

// OPS-04: woken by the database every minute while background work is due. Secret in the Authorization header.
export async function POST(request: Request) {
  return runJobsRoute(request);
}
