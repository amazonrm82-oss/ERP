import "server-only";

import { decryptSecret, SecretError } from "@/features/integrations/crypto";
import { secretKeyring } from "@/features/integrations/keys-server";
import { metaGraphProvider } from "@/features/meta-leads/graph/select";
import type { GraphErrorCode } from "@/features/meta-leads/graph/types";
import { withTimeout } from "@/features/meta-leads/timeout";
import { createServiceClient } from "@/lib/supabase/service";

import type { ConnectionTestOutcome } from "./test-messages";

/**
 * INT-01 "test connection" with the STORED page token (owner, 10 November 2026, answer (227) ב; CLAUDE.md hard rule 5).
 * Called only by testConnectionAction, AFTER the person's own session was checked (an active owner or admin of the
 * business who reads the connection under RLS). With the service key it calls only public.integration_test_claim() (the
 * person is checked again there; 5 tests per connection in 10 minutes; the ciphertext and page id of THIS connection only)
 * and public.integration_test_finish() (writes only verified_at / last_error_code and one log line, under CAP-11's
 * page-ownership rule). The token is decrypted in memory, handed to the provider's checkPage (/me) within
 * PROVIDER_TIMEOUT_MS, and never logged, stored or returned.
 */

export type ConnectionTestResult = { outcome: ConnectionTestOutcome; retrySeconds?: number };

type Claim = { lease?: unknown; page_id?: unknown; ciphertext?: unknown; refused?: unknown; retry_seconds?: unknown };

const REFUSALS = new Set(["not_found", "read_only", "feature", "closed", "no_secret", "rate"]);
const FINISHED = new Set<ConnectionTestOutcome>([
  "ok",
  "page_taken",
  "token_invalid",
  "not_found",
  "graph_unavailable",
  "rate_limited",
  "secret_unreadable",
  "changed",
  "closed",
  "expired",
  "busy",
  "error",
]);

export async function runConnectionTest(orgId: string, integrationId: string, userId: string): Promise<ConnectionTestResult> {
  const provider = metaGraphProvider();
  if (!provider) return { outcome: "no_provider" };
  const keys = secretKeyring();
  if (keys.length === 0) return { outcome: "no_key" };
  const supabase = createServiceClient();
  if (!supabase) return { outcome: "error" };

  const claimed = await supabase.rpc("integration_test_claim", { p_org: orgId, p_integration: integrationId, p_user: userId });
  if (claimed.error || !claimed.data || typeof claimed.data !== "object" || Array.isArray(claimed.data)) return { outcome: "error" };
  const claim = claimed.data as Claim;
  if (typeof claim.refused === "string") {
    if (!REFUSALS.has(claim.refused)) return { outcome: "error" };
    const retry = typeof claim.retry_seconds === "number" ? claim.retry_seconds : undefined;
    return { outcome: `refused_${claim.refused}` as ConnectionTestOutcome, retrySeconds: retry };
  }
  if (typeof claim.lease !== "string" || typeof claim.page_id !== "string" || typeof claim.ciphertext !== "string") {
    return { outcome: "error" };
  }

  let result: "ok" | GraphErrorCode | "secret_unreadable";
  try {
    const token = decryptSecret(claim.ciphertext, keys, { organizationId: orgId, integrationId, externalId: claim.page_id });
    const check = await withTimeout(provider.checkPage(claim.page_id, token), { ok: false as const, code: "graph_unavailable" as const });
    result = check.ok ? "ok" : check.code;
  } catch (error) {
    // never the value: only that the stored envelope did not open with this deployment's keys
    result = error instanceof SecretError ? "secret_unreadable" : "graph_unavailable";
  }

  const finished = await supabase.rpc("integration_test_finish", {
    p_org: orgId,
    p_integration: integrationId,
    p_lease: claim.lease,
    p_result: result,
  });
  if (finished.error || typeof finished.data !== "string") return { outcome: "error" };
  const outcome = finished.data as ConnectionTestOutcome;
  return { outcome: FINISHED.has(outcome) ? outcome : "error" };
}
