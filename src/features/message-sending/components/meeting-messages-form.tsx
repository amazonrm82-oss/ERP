"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { TextLink } from "@/components/ui/text-link";
import { messageTemplatesPath } from "@/features/message-templates/paths";
import type { FormState } from "@/lib/action-result";

import { saveMeetingMessagesAction } from "../actions";
import { MEETING_MESSAGE_TEXTS } from "../meeting-messages";
import type { MeetingMessages } from "../queries";

// `available`: the plan holds the key meeting_reminders; without it a switch can only be turned off
type Props = { orgId: string; settings: MeetingMessages; available: boolean };

/** CAL-12: the meeting messages to the customer. Owners and admins of a writable business. */
export function MeetingMessagesForm({ orgId, settings, available }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveMeetingMessagesAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const checked = (name: "meeting_confirm" | "meeting_remind_day" | "meeting_remind_hour", stored: boolean) =>
    failure?.values ? failure.values[name] === "on" : stored;

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="meeting-messages-title">
        <CardHeader id="meeting-messages-title" title={MEETING_MESSAGE_TEXTS.title} />
        <CardBody className="space-y-5">
          <p className="text-sm text-ink-soft">{MEETING_MESSAGE_TEXTS.intro}</p>
          <p className="text-sm text-ink-soft">{MEETING_MESSAGE_TEXTS.allOff}</p>
          {available ? null : <p className="text-sm text-ink">{MEETING_MESSAGE_TEXTS.notInPlan}</p>}
          <Checkbox
            name="meeting_confirm"
            label={MEETING_MESSAGE_TEXTS.confirm}
            hint={MEETING_MESSAGE_TEXTS.confirmHint}
            defaultChecked={checked("meeting_confirm", settings.confirm)}
            disabled={!available && !settings.confirm}
          />
          <Checkbox
            name="meeting_remind_day"
            label={MEETING_MESSAGE_TEXTS.day}
            defaultChecked={checked("meeting_remind_day", settings.day)}
            disabled={!available && !settings.day}
          />
          <Checkbox
            name="meeting_remind_hour"
            label={MEETING_MESSAGE_TEXTS.hour}
            defaultChecked={checked("meeting_remind_hour", settings.hour)}
            disabled={!available && !settings.hour}
          />
          <p className="text-sm text-ink-soft">{MEETING_MESSAGE_TEXTS.dayCap}</p>
          <p className="text-sm text-ink-soft">
            {MEETING_MESSAGE_TEXTS.templates} <TextLink href={messageTemplatesPath(orgId)}>לתבניות ההודעה</TextLink>
          </p>
          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}
