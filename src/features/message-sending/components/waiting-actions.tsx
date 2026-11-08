"use client";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { TextLink } from "@/components/ui/text-link";
import { paths } from "@/lib/paths";

import { cancelWaitingMessagesAction } from "../actions";
import { CHANNEL_LABELS, type MessageChannelKey } from "../usage";

type Props = { orgId: string; channel: MessageChannelKey; count: number };

/** MSG-05 (135) ב: what an owner or admin can do with marketing messages waiting for the cap: cancel them, or upgrade the plan. */
export function WaitingActions({ orgId, channel, count }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ConfirmButton
        title={`לבטל ${count === 1 ? "הודעת שיווק אחת" : `${count} הודעות שיווק`} ב${channel === "email" ? "אימייל" : `-${CHANNEL_LABELS[channel]}`}?`}
        description="ההודעות שמחכות לתקרה לא יישלחו. אי אפשר לבטל את הפעולה."
        confirmLabel="ביטול ההודעות"
        action={cancelWaitingMessagesAction.bind(null, orgId, channel)}
      >
        ביטול
      </ConfirmButton>
      <TextLink href={paths.settingsPlan(orgId)}>שדרוג</TextLink>
    </div>
  );
}
