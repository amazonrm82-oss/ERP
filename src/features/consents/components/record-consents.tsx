import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";

import { BLOCK_LABELS, CHANNEL_LABELS, LIFT_METHOD_LABELS, SOURCE_LABELS, STATE_LABELS, STATE_TONES, channelNeeds, type ConsentChannel } from "../model";
import { getRecordConsents, type ConsentSubject } from "../queries";
import { RecordConsentButton } from "./record-consent-button";

type Props = {
  orgId: string;
  subject: ConsentSubject;
  // may the user edit the record (a hint; the database decides)
  canEdit: boolean;
  hasPhone: boolean;
  hasEmail: boolean;
  // an owner or admin (the lift of an opt-out)
  canLift: boolean;
};

/**
 * CNS-03: the "הסכמה לדיוור" card of a lead or contact: the state of each channel (the latest
 * entry), and the whole history under it. Entries are never changed; a new state is a new entry.
 */
export async function RecordConsents({ orgId, subject, canEdit, hasPhone, hasEmail, canLift }: Props) {
  const { channels, history } = await getRecordConsents(orgId, subject);
  const available: ConsentChannel[] = channels
    .map((c) => c.channel)
    .filter((channel) => (channelNeeds(channel) === "email" ? hasEmail : hasPhone));

  return (
    <Card aria-labelledby="record-consents-title">
      <CardHeader
        id="record-consents-title"
        title="הסכמה לדיוור"
        action={canEdit ? <RecordConsentButton orgId={orgId} subject={subject} channels={available} canLift={canLift} /> : null}
      />
      <CardBody className="space-y-4">
        <ul className="divide-y divide-line">
          {channels.map(({ channel, latest, block, awaiting }) => {
            // CNS-06: a blocked address overrides a "granted" or unknown state of the record (an opt-out shows as itself)
            const blocked = block && (!latest || latest.state === "granted" || latest.state === "unknown") ? block : null;
            return (
              <li key={channel} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{CHANNEL_LABELS[channel]}</span>
                  {blocked ? (
                    <Badge tone="danger">{BLOCK_LABELS[blocked]}</Badge>
                  ) : (
                    <Badge tone={STATE_TONES[latest?.state ?? "unknown"]}>{STATE_LABELS[latest?.state ?? "unknown"]}</Badge>
                  )}
                </div>
                {blocked && latest ? <p className="mt-1 text-sm text-ink-soft">המצב ברשומה: {STATE_LABELS[latest.state]}</p> : null}
                {latest ? (
                  <p className="mt-1 text-sm text-ink-soft">
                    {[latest.source ? SOURCE_LABELS[latest.source] : null, latest.recordedBy].filter(Boolean).join(" · ")}
                    {" · "}
                    <time dateTime={latest.createdAt}>{formatDateTime(latest.createdAt)}</time>
                  </p>
                ) : null}
                {awaiting ? (
                  <div className="mt-2 space-y-1">
                    <Badge tone={STATE_TONES.awaiting_confirmation}>{STATE_LABELS.awaiting_confirmation}</Badge>
                    <p className="text-sm text-ink-soft">
                      {awaiting.method ?? SOURCE_LABELS.form}
                      {" · "}
                      <time dateTime={awaiting.createdAt}>{formatDateTime(awaiting.createdAt)}</time>
                    </p>
                    <p className="text-sm text-ink-soft">סומן בטופס אחרי הסרה או חסימה. ההסכמה לא חוזרת עד שהאדם יאשר אותה בעצמו.</p>
                  </div>
                ) : null}
                {latest && latest.currentAddress === false ? (
                  <p className="mt-1 text-sm text-warning">
                    {channelNeeds(channel) === "email" ? "נרשם לכתובת אימייל אחרת מזו שברשומה היום." : "נרשם למספר טלפון אחר מזה שברשומה היום."}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        {canEdit && available.length < channels.length ? (
          <p className="text-sm text-ink-soft">
            {available.length === 0
              ? "כדי לרשום הסכמה, הוסיפו לרשומה טלפון או אימייל."
              : hasPhone
                ? "כדי לרשום הסכמה לאימייל, הוסיפו לרשומה כתובת אימייל."
                : "כדי לרשום הסכמה ל-SMS, ל-WhatsApp או לשיחות, הוסיפו לרשומה מספר טלפון."}
          </p>
        ) : null}
        {history.length > 0 ? (
          <details className="border-t border-line pt-3">
            <summary className="cursor-pointer text-md font-medium">היסטוריית ההסכמות ({history.length})</summary>
            <ol className="mt-3 space-y-3">
              {history.map((entry) => (
                <li key={entry.id} className="text-sm">
                  <p>
                    <span className="font-medium">{CHANNEL_LABELS[entry.channel]}:</span> {STATE_LABELS[entry.state]}
                  </p>
                  <p className="text-ink-soft">
                    {[entry.source ? SOURCE_LABELS[entry.source] : null, entry.recordedBy].filter(Boolean).join(" · ")}
                    {" · "}
                    <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                  </p>
                  {entry.method ? <p className="break-words text-ink-soft">איך התקבלה: {entry.method}</p> : null}
                  {entry.liftMethod ? <p className="text-ink-soft">ביטול הסרה: {LIFT_METHOD_LABELS[entry.liftMethod]}</p> : null}
                  {entry.wording ? (
                    <p className="break-words whitespace-pre-line text-ink-soft">
                      נוסח{entry.wordingVersion ? <span dir="ltr"> ({entry.wordingVersion})</span> : null}: {entry.wording}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </CardBody>
    </Card>
  );
}
