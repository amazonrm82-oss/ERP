import type { RecordSmsKind } from "../logic";
import { getRecordSmsSetup } from "../queries";

import { SendSmsDialog } from "./send-sms-dialog";

type Props = {
  orgId: string;
  kind: RecordSmsKind;
  recordId: string;
  userName: string;
  businessName: string;
  timeZone: string;
  canManageTemplates: boolean;
};

/**
 * SMS-02: the card's "שליחת SMS" (for a person who may write and reads the record; the database judges both again). Nothing
 * when the record has no phone to send to (a deal: its contact's). The page wraps it in <Suspense>, so the card renders first.
 */
export async function SendSmsButton({ orgId, kind, recordId, userName, businessName, timeZone, canManageTemplates }: Props) {
  const setup = await getRecordSmsSetup(orgId, kind, recordId);
  if (!setup) return null;
  return (
    <SendSmsDialog
      orgId={orgId}
      kind={kind}
      recordId={recordId}
      phone={setup.phone}
      templates={setup.templates.map((t) => ({ id: t.id, name: t.name, messageType: t.messageType, body: t.body }))}
      queued={setup.queued}
      values={{ ...setup.values, userName, businessName }}
      canManageTemplates={canManageTemplates}
      timeZone={timeZone}
    />
  );
}
