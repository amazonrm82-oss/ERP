import type { RecordEmailKind } from "../logic";
import { getRecordEmailSetup } from "../queries";

import { SendEmailDialog } from "./send-email-dialog";

type Props = {
  orgId: string;
  kind: RecordEmailKind;
  recordId: string;
  userName: string;
  businessName: string;
  timeZone: string;
  canManageTemplates: boolean;
};

/**
 * EML-02: the card's "שליחת אימייל" (for a person who may write and reads the record, owner (193) ב; the database judges
 * both again). Nothing when the record has no email address to send to (a deal: its contact's). The page wraps it in
 * <Suspense>, so the card renders first.
 */
export async function SendEmailButton({ orgId, kind, recordId, userName, businessName, timeZone, canManageTemplates }: Props) {
  const setup = await getRecordEmailSetup(orgId, kind, recordId);
  if (!setup) return null;
  return (
    <SendEmailDialog
      orgId={orgId}
      kind={kind}
      recordId={recordId}
      address={setup.address}
      templates={setup.templates.map((t) => ({ id: t.id, name: t.name, messageType: t.messageType, subject: t.subject, body: t.body }))}
      files={setup.files}
      library={setup.library}
      queued={setup.queued}
      values={{ ...setup.values, userName, businessName }}
      canManageTemplates={canManageTemplates}
      timeZone={timeZone}
    />
  );
}
