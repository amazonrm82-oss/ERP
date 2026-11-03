import { anonHealthCall, healthResponse } from "@/features/health/health-server";

// OPS-05: uptime check for an external monitor. No session, no service key; answers 200 {ok:true} or 503 {ok:false}.
export const dynamic = "force-dynamic";

export async function GET() {
  return healthResponse(anonHealthCall());
}
