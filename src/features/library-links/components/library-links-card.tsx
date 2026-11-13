import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { libraryPath } from "@/features/library/paths";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { formatDateTime } from "@/lib/format";

import { getLibraryLinksCard } from "../queries";
import type { LibraryRecord } from "../record";
import { libraryRecipientTexts, LIBRARY_CARD_TEXTS as T, viewsText } from "../texts";
import { LibraryLinksPanel } from "./library-links-panel";

type Props = {
  orgId: string;
  record: LibraryRecord;
  recipient: { name: string | null; phoneE164: string | null; email: string | null };
  // the page's hint that the viewer may edit the record (owner (294) ב); the database decides
  canEditRecord?: boolean;
};

/**
 * LIB-02: "חומרים מהספרייה" on the lead, contact, company and deal pages: send an item of the content library by a personal
 * tracked link, and see when the customer opened it (QUO-10's way). Whoever reads the record sees the list; whoever writes in
 * the business sends; the database decides the rest.
 */
export async function LibraryLinksCard({ orgId, record, recipient, canEditRecord = false }: Props) {
  const [data, context, terms] = await Promise.all([getLibraryLinksCard(orgId, record, canEditRecord), getOrgContext(orgId), getOrgTerms(orgId)]);
  const titleId = `library-links-${record.id}`;
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader id={titleId} title={T.title} />
      <CardBody>
        <LibraryLinksPanel
          orgId={orgId}
          record={record}
          canWrite={data.canWrite}
          offerable={data.offerable}
          links={data.links.map((link) => ({
            id: link.id,
            itemTitle: link.itemTitle ?? "פריט",
            meta: [formatDateTime(link.createdAt), link.createdByName].filter(Boolean).join(" · "),
            views: viewsText(link.viewCount, link.lastViewedAt ? formatDateTime(link.lastViewedAt) : ""),
            revoked: link.revokedAt !== null,
            canRevoke: link.canRevoke,
          }))}
          libraryHref={libraryPath(orgId)}
          businessName={context.org.name}
          recipient={recipient}
          texts={libraryRecipientTexts(record.kind, terms)}
        />
      </CardBody>
    </Card>
  );
}
