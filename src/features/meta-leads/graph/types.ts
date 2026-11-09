/**
 * CAP-11: the Graph API layer. A provider fetches one lead's answers with the page token, and checks a page token when
 * a page is connected. Only the fake exists until the owner sets the App ID and App Secret in Vercel (owner (126) א);
 * the real adapter is one file plus one line in select.ts.
 */

/** A lead as the Graph API answers it (`GET /<leadgen id>?fields=field_data,form_id,platform,campaign_name`). */
export type GraphLead = {
  field_data: { name: string; values: string[] }[];
  form_id?: string;
  /** "fb" | "ig" */
  platform?: string;
  campaign_name?: string;
};

/** Error codes the database keeps (^[a-z_]{1,40}$; never a message). */
export type GraphErrorCode = "not_found" | "token_invalid" | "graph_unavailable" | "rate_limited";

export type GraphLeadResult = { ok: true; lead: GraphLead } | { ok: false; code: GraphErrorCode };
export type GraphPageResult = { ok: true } | { ok: false; code: GraphErrorCode };

/**
 * The contract every adapter keeps (review of 8 November 2026, findings 1 and 2):
 * - checkPage(pageId, token) proves the TOKEN's own identity is that page: the real adapter asks `GET /me?fields=id` with the
 *   token and compares the answered id with pageId. That `GET /<pageId>` succeeds proves nothing (any valid token reads a
 *   public page). Any other answer is an error, never ok.
 * - fetchLead(leadId, token, pageId) answers ok only when the token may read that lead (Graph refuses a lead of another
 *   page); a permission refusal is "token_invalid". A successful fetch verifies the connection (public.meta_lead_finish), so
 *   an adapter never answers ok for a lead it did not read with this token.
 * - Every call ends within PROVIDER_TIMEOUT_MS (webhook.ts wraps it), well under the claim's two-minute lease.
 */
export type MetaGraphProvider = {
  code: string;
  fetchLead(leadId: string, pageToken: string, pageId: string): Promise<GraphLeadResult>;
  checkPage(pageId: string, pageToken: string): Promise<GraphPageResult>;
};
