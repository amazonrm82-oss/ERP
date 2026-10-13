import { paths } from "@/lib/paths";

import { notificationHref } from "./links";

/** One row of public.claim_push_notifications(). `type` and `lead_actions` arrive since SPD-01. */
export type ClaimedNotification = {
  id: string;
  organization_id: string;
  user_id: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  organization_name: string;
  type?: string | null;
  lead_actions?: boolean | null;
};

export type PushAction = "take" | "call" | "whatsapp";

/**
 * The buttons of a new-lead push (SPD-01), most important first: a browser that
 * shows fewer buttons (Chrome on Android shows two) keeps the first ones, and
 * the screen the push opens always has all three.
 */
export const LEAD_PUSH_ACTIONS: readonly { action: PushAction; title: string }[] = [
  { action: "take", title: "לקחתי" },
  { action: "call", title: "חיוג" },
  { action: "whatsapp", title: "WhatsApp" },
];

/**
 * What the service worker (public/sw.js) receives: { title, body, url, tag },
 * plus for a new lead `actions` and `links` (where each button goes). No lead
 * data beyond the notification's own title and body: the phone number is read
 * by the screen, with the user's session, never sent in the push.
 */
export type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
  actions?: { action: PushAction; title: string }[];
  links?: Record<PushAction, string>;
};

export function pushPayload(notification: ClaimedNotification): PushPayload {
  const org = notification.organization_id;
  const body = notification.body ? `${notification.organization_name}: ${notification.body}` : notification.organization_name;
  if (notification.lead_actions === true && notification.entity_type === "lead" && notification.entity_id) {
    const lead = notification.entity_id;
    return {
      title: notification.title,
      body,
      url: paths.leadRespond(org, lead),
      tag: notification.id,
      actions: LEAD_PUSH_ACTIONS.map((a) => ({ ...a })),
      links: {
        take: paths.leadTake(org, lead),
        call: paths.leadRespond(org, lead, "call"),
        whatsapp: paths.leadRespond(org, lead, "whatsapp"),
      },
    };
  }
  return {
    title: notification.title,
    body,
    url: notificationHref(org, notification.entity_type, notification.entity_id) ?? paths.notifications(org),
    tag: notification.id,
  };
}
