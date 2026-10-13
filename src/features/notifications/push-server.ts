import "server-only";

import { timingSafeEqual } from "node:crypto";

import webpush from "web-push";

import { createServiceClient } from "@/lib/supabase/service";

import { pushPayload, type ClaimedNotification } from "./push-payload";

/** The settings Web Push needs on the server, or null when any is missing. */
function pushConfig() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const secret = process.env.PUSH_DISPATCH_SECRET?.trim();
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  if (!publicKey || !privateKey || !secret || !site) {
    return null;
  }
  return { publicKey, privateKey, secret, site };
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Called by the database (app.dispatch_push, through pg_net) when there are
 * notifications to push. It is not a user request: it carries a shared secret,
 * and uses the service role to claim the batch and read the subscriptions.
 */
export async function dispatchPush(request: Request): Promise<Response> {
  const config = pushConfig();
  const supabase = createServiceClient();
  if (!config || !supabase) {
    return json(503, { error: "push is not configured" });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), config.secret)) {
    return json(401, { error: "unauthorized" });
  }

  const { data, error } = await supabase.rpc("claim_push_notifications", { p_limit: 200 });
  if (error) {
    return json(500, { error: "claim failed" });
  }
  const batch = (data ?? []) as ClaimedNotification[];
  if (batch.length === 0) {
    return json(200, { sent: 0 });
  }

  const userIds = [...new Set(batch.map((n) => n.user_id))];
  const { data: subscriptions, error: subError } = await supabase
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .in("user_id", userIds);
  if (subError) {
    return json(500, { error: "subscriptions query failed" });
  }

  const options = {
    // must be https: or mailto: (a local http site falls back to a placeholder address)
    vapidDetails: { subject: config.site.startsWith("https://") ? config.site : "mailto:push@localhost.invalid", publicKey: config.publicKey, privateKey: config.privateKey },
    TTL: 60 * 60,
    timeout: 10_000,
  };
  const gone = new Set<string>();
  let sent = 0;

  await Promise.all(
    batch.flatMap((notification) => {
      const payload = JSON.stringify(pushPayload(notification));
      return (subscriptions ?? [])
        .filter((s) => s.user_id === notification.user_id)
        .map(async (s) => {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options);
            sent += 1;
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            // the browser dropped the subscription: forget it
            if (status === 404 || status === 410) {
              gone.add(s.id);
            } else {
              console.error("push send failed", status ?? (err as Error).message);
            }
          }
        });
    }),
  );

  if (gone.size > 0) {
    await supabase.from("push_subscriptions").delete().in("id", [...gone]);
  }
  return json(200, { sent, removed: gone.size });
}
