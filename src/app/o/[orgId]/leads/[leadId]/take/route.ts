import { isOwnTakeRequest, takeMessage } from "@/features/leads/take";
import { takeLead } from "@/features/leads/take-server";
import { getSessionUser } from "@/lib/auth";
import { NOT_FOUND, SESSION_EXPIRED } from "@/lib/errors";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * "לקחתי" pressed on the push itself (SPD-01): the service worker posts here
 * with the user's own cookies; the database decides (public.take_lead()).
 * Answers { ok, message } for the follow-up notification.
 */
export async function POST(request: Request, { params }: { params: Promise<{ orgId: string; leadId: string }> }) {
  const { orgId, leadId } = await params;
  if (!isOwnTakeRequest(request.headers)) {
    return json(403, { ok: false, message: NOT_FOUND });
  }
  if (!isUuid(orgId) || !isUuid(leadId)) {
    return json(404, { ok: false, message: NOT_FOUND });
  }
  if (!(await getSessionUser())) {
    return json(401, { ok: false, message: SESSION_EXPIRED });
  }
  const answer = await takeLead(await createClient(), orgId, leadId);
  if (!answer.ok) {
    return json(200, { ok: false, message: answer.message });
  }
  return json(200, { ok: answer.outcome.ok, message: takeMessage(answer.outcome) });
}
