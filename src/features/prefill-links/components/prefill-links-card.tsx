import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { formatDateTime } from "@/lib/format";

import type { PrefillRecordType } from "../fields";
import { prefillFormsSettingsPath } from "../paths";
import { getRecordPrefillLinks, listPrefillForms, prefillInPlan } from "../queries";
import { PREFILL_CARD_TEXTS as T, PREFILL_STATE_LABELS, prefillRecipientTexts } from "../texts";
import { PrefillLinksPanel } from "./prefill-links-panel";

type Props = {
  orgId: string;
  record: { kind: PrefillRecordType; id: string };
  recipient: { name: string | null; phoneE164: string | null };
  // the page's hint that the viewer may edit the record; the database decides
  canEditRecord?: boolean;
};

/**
 * BIZ-05: "טופס השלמת פרטים" on the lead and contact pages: send the person a personal link to a form with the details the
 * business already holds (an intake questionnaire, details before a meeting); the answers go into the record and its timeline.
 */
export async function PrefillLinksCard({ orgId, record, recipient, canEditRecord = false }: Props) {
  const [context, forms, links, inPlan, terms] = await Promise.all([
    getOrgContext(orgId),
    listPrefillForms(orgId),
    getRecordPrefillLinks(orgId, record.kind, record.id),
    prefillInPlan(orgId),
    getOrgTerms(orgId),
  ]);
  const titleId = `prefill-links-${record.id}`;
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader id={titleId} title={T.title} />
      <CardBody>
        <PrefillLinksPanel
          orgId={orgId}
          record={record}
          canSend={context.canWrite && canEditRecord && inPlan}
          notInPlan={!inPlan}
          forms={forms.filter((f) => f.isActive && f.recordType === record.kind).map((f) => ({ id: f.id, name: f.name }))}
          links={links.map((link) => ({
            id: link.id,
            formName: link.formName,
            meta: [formatDateTime(link.createdAt), link.createdByName].filter(Boolean).join(" · "),
            state: PREFILL_STATE_LABELS[link.state],
            canRevoke: link.canRevoke,
          }))}
          settingsHref={prefillFormsSettingsPath(orgId)}
          businessName={context.org.name}
          recipient={recipient}
          texts={prefillRecipientTexts(record.kind, terms)}
        />
      </CardBody>
    </Card>
  );
}
