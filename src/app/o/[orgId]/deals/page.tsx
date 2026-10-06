import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { PlusIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { DealsBoard } from "@/features/deals/components/deals-board";
import { BOARD_LIMIT, getBoard, listPipelines } from "@/features/deals/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatMoney, formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";
import { paths } from "@/lib/paths";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "עסקאות" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DealsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const { canWrite } = await getOrgContext(orgId);
  const requested = firstParam((await searchParams).pipeline);
  const [board, pipelines] = await Promise.all([getBoard(orgId, requested), listPipelines(orgId)]);

  if (!board) {
    return (
      <>
        <PageHeader title="עסקאות" />
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            title="אין פייפליין מכירות"
            description="כדי לנהל עסקאות צריך פייפליין עם שלבים. מנהל המערכת יכול להוסיף אחד בהגדרות."
          />
        </div>
      </>
    );
  }

  const openStageIds = new Set(board.stages.filter((stage) => stage.kind === "open").map((stage) => stage.id));
  const openDeals = board.deals.filter((deal) => openStageIds.has(deal.stageId));
  const openTotal = openDeals.reduce((sum, deal) => sum + deal.amountAgorot, 0);

  const newDealButton = canWrite ? (
    <ButtonLink href={`${paths.dealNew(orgId)}?pipeline=${board.pipeline.id}`}>
      <PlusIcon className="size-4.5" />
      עסקה חדשה
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader
        title="עסקאות"
        description={
          board.deals.length > 0
            ? `פייפליין ${board.pipeline.name}: ${formatNumber(openDeals.length)} עסקאות פתוחות בשווי ${formatMoney(openTotal)}.`
            : `פייפליין ${board.pipeline.name}`
        }
        actions={newDealButton}
      />

      {pipelines.length > 1 ? (
        <nav aria-label="פייפליינים" className="mb-4 flex flex-wrap gap-2">
          {pipelines.map((pipeline) => {
            const active = pipeline.id === board.pipeline.id;
            return (
              <Link
                key={pipeline.id}
                href={pipeline.isDefault ? paths.deals(orgId) : `${paths.deals(orgId)}?pipeline=${pipeline.id}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm",
                  active ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line bg-surface hover:bg-canvas",
                )}
              >
                {pipeline.name}
              </Link>
            );
          })}
        </nav>
      ) : null}

      {board.truncated ? (
        <p role="status" className="mb-4 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          מוצגות {formatNumber(BOARD_LIMIT)} העסקאות שעודכנו לאחרונה. הספירה והסכומים בלוח מתייחסים רק אליהן.
        </p>
      ) : null}

      {board.deals.length === 0 ? (
        <div className="mb-5 rounded-lg border border-line bg-surface">
          <EmptyState
            title="עוד אין עסקאות"
            description="עסקה נוצרת כשממירים ליד, או ידנית מכאן. בלוח רואים בכל רגע כמה כסף נמצא בכל שלב."
            action={newDealButton}
          />
        </div>
      ) : null}

      <DealsBoard orgId={orgId} board={board} canWrite={canWrite} />
    </>
  );
}
