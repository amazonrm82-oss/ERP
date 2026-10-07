import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { PlusIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { DealsBoard } from "@/features/deals/components/deals-board";
import { getBoard, listPipelines } from "@/features/deals/queries";
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
  const query = await searchParams;
  const requested = firstParam(query.pipeline);
  const showClosed = firstParam(query.closed) === "1";
  const fullStage = firstParam(query.stage);
  const [board, pipelines] = await Promise.all([getBoard(orgId, requested, { showClosed, fullStage }), listPipelines(orgId)]);

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

  const openStages = board.stages.filter((stage) => stage.kind === "open");
  const openCount = openStages.reduce((sum, stage) => sum + (board.totals[stage.id]?.count ?? 0), 0);
  const openTotal = openStages.reduce((sum, stage) => sum + (board.totals[stage.id]?.amountAgorot ?? 0), 0);
  const anyDeals = Object.values(board.totals).some((t) => t.count > 0);
  // the board's address with one setting changed, keeping the others
  const boardHref = (change: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const current: Record<string, string | null> = { pipeline: requested ?? null, closed: showClosed ? "1" : null, stage: fullStage ?? null, ...change };
    for (const [key, value] of Object.entries(current)) if (value) params.set(key, value);
    const qs = params.toString();
    return qs ? `${paths.deals(orgId)}?${qs}` : paths.deals(orgId);
  };

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
          anyDeals
            ? `פייפליין ${board.pipeline.name}: ${formatNumber(openCount)} עסקאות פתוחות בשווי ${formatMoney(openTotal)}.`
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

      <p className="mb-3 text-sm">
        <Link href={boardHref({ closed: showClosed ? null : "1" })} className="text-accent-strong underline underline-offset-4">
          {showClosed ? "הסתרת עסקאות שנסגרו" : "הצגת עסקאות שנסגרו (בהצלחה ואבודות)"}
        </Link>
      </p>

      {!anyDeals ? (
        <div className="mb-5 rounded-lg border border-line bg-surface">
          <EmptyState
            title="עוד אין עסקאות"
            description="עסקה נוצרת כשממירים ליד, או ידנית מכאן. בלוח רואים בכל רגע כמה כסף נמצא בכל שלב."
            action={newDealButton}
          />
        </div>
      ) : null}

      <DealsBoard
        orgId={orgId}
        board={board}
        canWrite={canWrite}
        hrefs={{
          showClosed: boardHref({ closed: "1" }),
          ...Object.fromEntries(board.stages.map((stage) => [stage.id, boardHref({ stage: stage.id })])),
        }}
      />
    </>
  );
}
