import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { BulkSelection, RowCheck } from "@/features/bulk/components/bulk-selection";
import { asCustomValues, type FieldDefinition } from "@/features/custom-fields/types";
import { InlineEdit } from "@/features/inline-edit/components/inline-edit";
import type { InlineEditing } from "@/features/inline-edit/server";
import type { CatalogColumn, ColumnChoice } from "@/features/list-columns/columns";
import { ListTable } from "@/features/list-columns/components/list-table";
import type { TagOption } from "@/features/tags/queries";
import { formatDate, formatMoney } from "@/lib/format";
import { paths } from "@/lib/paths";
import type { Sort } from "@/lib/sort";

import { DEAL_STATUS } from "../display";
import { DealStageCell } from "./deal-stage-cell";
import type { CloseWindowSetup } from "./deal-won-dialog";
import type { DealListItem, StageOption } from "../queries";

type Props = {
  orgId: string;
  deals: DealListItem[];
  // the stages of the pipeline on screen, in order
  stages: StageOption[];
  columns: ColumnChoice[];
  catalog: CatalogColumn[];
  fields: FieldDefinition[];
  sort: Sort<string>;
  sortHref: (key: string) => string;
  editing: InlineEditing;
  tags: TagOption[];
  // DEAL-03: the names of the active loss reasons, offered when a deal moves to a lost stage
  lossReasons: string[];
  // DEAL-04: what the close window needs when a deal moves into a won stage; null for a viewer
  closeWindow: CloseWindowSetup | null;
};

/** A pipeline's deals as a table (LST-09): the same columns, sorting, editing in the cell and bulk actions as the other lists. */
export function DealsTable({ orgId, deals, stages, columns, catalog, fields, sort, sortHref, editing, tags, lossReasons, closeWindow }: Props) {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  // a lost stage offers a reason, when the organization has any (optional)
  const stageOptions = stages.map((stage) => ({ value: stage.id, label: stage.name, needsReason: stage.kind === "lost" && lossReasons.length > 0 }));

  return (
    <BulkSelection
      orgId={orgId}
      object="deal"
      ids={deals.map((row) => row.id)}
      owners={editing.bulk?.reassign ? editing.owners : null}
      statuses={null}
      stages={stageOptions}
      reasons={lossReasons}
      tags={tags.map((tag) => ({ value: tag.id, label: tag.name }))}
      canTrash={editing.bulk?.trash ?? false}
      exportPath={editing.bulk?.exportable ? `${paths.deals(orgId)}/export` : null}
      enabled={editing.bulk !== null}
    >
      <ListTable
        label="טבלת עסקאות"
        rows={deals}
        rowKey={(deal) => deal.id}
        columns={columns}
        catalog={catalog}
        fields={fields}
        sort={sort}
        sortHref={sortHref}
        customValues={(deal) => asCustomValues(deal.customFields)}
        nameCell={(deal) => (
          <div className="flex items-start gap-2">
            <RowCheck id={deal.id} label={deal.name} />
            <div className="min-w-0">
              <InlineEdit
                orgId={orgId}
                object="deal"
                id={deal.id}
                field="name"
                kind="text"
                label={`שם: ${deal.name}`}
                initial={{ text: deal.name }}
                canEdit={editing.canEdit(deal.ownerId)}
              >
                <Link href={paths.deal(orgId, deal.id)} className="font-medium text-ink underline-offset-4 hover:underline">
                  {deal.name}
                </Link>
              </InlineEdit>
            </div>
          </div>
        )}
        cell={(key, deal) => {
          switch (key) {
            case "amount":
              return <span className="whitespace-nowrap">{formatMoney(deal.amountAgorot)}</span>;
            case "stage":
              return (
                <DealStageCell
                  orgId={orgId}
                  deal={{ id: deal.id, name: deal.name, stageId: deal.stageId, amountAgorot: deal.amountAgorot, ownerId: deal.ownerId }}
                  stages={stages}
                  lossReasons={lossReasons}
                  closeWindow={closeWindow}
                  canEdit={editing.canEdit(deal.ownerId)}
                >
                  {stageById.get(deal.stageId)?.name ?? null}
                </DealStageCell>
              );
            case "status":
              return <Badge tone={DEAL_STATUS[deal.status].tone}>{DEAL_STATUS[deal.status].label}</Badge>;
            case "contact":
              return deal.contactId && deal.contactName ? (
                <Link href={paths.contact(orgId, deal.contactId)} className="underline-offset-4 hover:underline">
                  {deal.contactName}
                </Link>
              ) : null;
            case "company":
              return deal.companyName;
            case "owner":
              return (
                <InlineEdit
                  orgId={orgId}
                  object="deal"
                  id={deal.id}
                  field="owner"
                  kind="select"
                  label={`אחראי: ${deal.name}`}
                  initial={{ id: deal.ownerId }}
                  options={editing.owners}
                  emptyOption="ללא אחראי"
                  canEdit={editing.canReassign(deal.ownerId)}
                >
                  {deal.ownerName}
                </InlineEdit>
              );
            case "expected_close":
              return deal.expectedCloseDate ? <time dateTime={deal.expectedCloseDate} className="whitespace-nowrap">{formatDate(deal.expectedCloseDate)}</time> : null;
            case "created":
              return (
                <time dateTime={deal.createdAt} className="whitespace-nowrap text-ink-soft">
                  {formatDate(deal.createdAt)}
                </time>
              );
            default:
              return null;
          }
        }}
      />
    </BulkSelection>
  );
}
