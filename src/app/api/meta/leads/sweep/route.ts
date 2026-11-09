import { metaSweep } from "@/features/meta-leads/webhook-server";

// CAP-11: woken by the database (app.wake_meta_lead_sweep, pg_cron every 5 minutes) while a Meta lead waits to be
// fetched again. Secret in the Authorization header.
export async function POST(request: Request) {
  return metaSweep(request);
}
