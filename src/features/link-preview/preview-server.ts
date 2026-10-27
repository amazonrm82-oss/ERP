import "server-only";

import { keyedIpHash } from "@/lib/keyed-ip-hash";
import { createServiceClient } from "@/lib/supabase/service";

import { botPreviewFrom, type BotPreviewState, type PreviewKind } from "./bot-preview";

// WAB-05 follow-up (owner, 27 October 2026, answer (1) ב; CLAUDE.md hard rule 5): the preview a messaging app's fetcher gets
// for a customer page, in the approved pattern for secret-link pages. The server calls ONLY public.link_preview_public()
// (security definer, service_role only), which checks the token by the page's own rule and answers only the business's display
// name and logo (a card adds the name the card always shows). It counts no view, changes no status, tells nobody and runs no
// automation; its only write is its own rate-limit counters. No table is reached directly; no cookies, no visitor id.

const MAX_TOKEN = 128;

/** The preview of one customer page for a listed preview bot (src/lib/preview-bots.ts). Never throws for a bad token. */
export async function getBotPreview(kind: PreviewKind, token: string, ip: string | null): Promise<BotPreviewState> {
  if (token === "" || token.length > MAX_TOKEN) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("link_preview_public", {
    p_kind: kind,
    p_token: token,
    // FXS-11: the sender only as a keyed hash in its own scope; the database keeps a bucket number, never the hash
    p_ip_hash: keyedIpHash(ip, "preview"),
  });
  if (error) {
    // a preview is never worth an error page: log one redacted line and answer the generic preview
    console.error(`[WAB-05 preview] link_preview_public failed: ${error.code ?? "?"}`);
    return "not-configured";
  }
  return botPreviewFrom(data);
}
