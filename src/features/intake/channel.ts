// CON-10 follow-up (owner, 14 October 2026): a public form may ask how the person likes to be
// contacted. forms.channel_choice turns it on; intake_form() returns `channel_choice`; the hosted
// form sends one of the four channels as `preferred_channel`; intake_submit() keeps it on a new
// lead (source 'form') and fills an existing lead or contact only when its channel is empty or
// came from a form. The channels are the contacts' list (src/features/contacts/preferences.ts).

import { CHANNEL_OPTIONS, isContactChannel, type ContactChannel } from "@/features/contacts/preferences";

/** The input's name on the hosted form, and the payload key intake_submit() reads. */
export const CHANNEL_INPUT = "preferred_channel";

export const CHANNEL_QUESTION = "איך נוח שניצור איתכם קשר?";

export const PUBLIC_CHANNEL_OPTIONS = CHANNEL_OPTIONS;

/** A sent value as a channel, or null for none or anything outside the list. */
export function channelInput(value: string | null | undefined): ContactChannel | null {
  const trimmed = value?.trim();
  return isContactChannel(trimmed) ? trimmed : null;
}
