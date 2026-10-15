import { isOwnTakeRequest, takeMessage } from "@/features/leads/take";
import { takeLead } from "@/features/leads/take-server";
import { sessionCheck } from "@/lib/auth";
import { NOT_FOUND } from "@/lib/errors";
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
  const session = await sessionCheck();
  if (!session.ok) {
    // FXC-10: 503 when the sign-in service did not answer, so the push says to try again rather than to sign in
    return json(session.unavailable ? 503 : 401, { ok: false, message: session.message });
  }
  const answer = await takeLead(await createClient(), orgId, leadId);
  if (!answer.ok) {
    return json(200, { ok: false, message: answer.message });
  }
  return json(200, { ok: answer.outcome.ok, message: takeMessage(answer.outcome) });
}
