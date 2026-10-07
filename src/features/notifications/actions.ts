"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { NOTIFICATION_KINDS } from "./settings";

function revalidateNotifications(orgId: string) {
  // the bell keeps its own state; only the full list is re-read
  revalidatePath(paths.notifications(orgId));
}

/** Marks one notification, or all of the user's notifications in the organization, as read. */
export async function markNotificationsReadAction(orgId: string, notificationId: string | null): Promise<ActionResult> {
  const context = await actionContext(orgId, ...(notificationId ? [notificationId] : []));
  if (!context.ok) {
    return context;
  }
  // RLS limits the update to the user's own rows; read_at is the only column a user may set
  let query = context.supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("user_id", context.user.id)
    .is("read_at", null);
  if (notificationId) {
    query = query.eq("id", notificationId);
  }
  const { error } = await query;
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לעדכן את ההתראות. נסו שוב."));
  }
  revalidateNotifications(orgId);
  return ok();
}

const subscriptionSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

/** Saves this browser's Web Push subscription for the signed-in user (the database sets user_id). */
export async function savePushSubscriptionAction(orgId: string, subscription: unknown, userAgent: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = subscriptionSchema.safeParse(subscription);
  if (!parsed.success) {
    return fail("הדפדפן החזיר מינוי לא תקין. נסו שוב.");
  }
  const { endpoint, keys } = parsed.data;
  // the same browser subscribing again: replace the old row (it may hold stale keys)
  await context.supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  const { error } = await context.supabase
    .from("push_subscriptions")
    .insert({ endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: userAgent.slice(0, 300) || null });
  if (error) {
    // 23505: the endpoint is registered to another user who signed in on this browser before
    return fail(error.code === "23505" ? "הדפדפן הזה רשום להתראות של משתמש אחר. יש לבטל שם קודם." : dbErrorMessage(error, "לא הצלחנו להפעיל התראות. נסו שוב."));
  }
  return ok();
}

export async function deletePushSubscriptionAction(orgId: string, endpoint: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const { error } = await context.supabase.from("push_subscriptions").delete().eq("endpoint", endpoint.slice(0, 1000));
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לבטל את ההתראות. נסו שוב."));
  }
  return ok();
}


/** Saves which notifications the user gets, and where (bell, phone). Applies in every organization. */
export async function saveNotificationSettingsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const muted: string[] = [];
  const noPush: string[] = [];
  for (const kind of NOTIFICATION_KINDS) {
    const choice = formData.get(`kind_${kind.key}`);
    if (choice === "off") muted.push(kind.key);
    else if (choice === "bell") noPush.push(kind.key);
  }
  const { error } = await context.supabase.rpc("set_notification_settings", { p_muted: muted, p_no_push: noPush });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."));
  }
  revalidatePath(paths.settingsAccount(orgId));
  return { ok: true, message: "ההעדפות נשמרו." };
}
