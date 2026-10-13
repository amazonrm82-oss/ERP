import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { asCustomValues, type FieldDefinition } from "@/features/custom-fields/types";
import { displayCustomFields } from "@/features/custom-fields/values";
import { CUSTOM_PREFIX } from "@/features/list-columns/columns";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import { daysInStageLabel } from "../board-fields";
import type { BoardDeal } from "../queries";

// names the page already has: owners and tags by id
export type CardLookups = { owners: Record<string, string>; tags: Record<string, string>; fields: FieldDefinition[] };

const linkClass = "text-ink-soft underline-offset-4 hover:text-ink hover:underline";

/** One labelled line of a card ("צפי סגירה: 12.10.2026"); the label is visible and read out. */
function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="mt-0.5 break-words text-sm">
      <span className="text-ink-soft">{label}: </span>
      {children}
    </p>
  );
}

/**
 * The fields a deal card shows, in the user's order (DEAL-09). An empty field is
 * left out, so a card stays short; the deal's name and the stage menu are drawn by the board.
 */
export function DealCardFields({ orgId, deal, keys, stuck, lookups }: { orgId: string; deal: BoardDeal; keys: string[]; stuck: string | undefined; lookups: CardLookups }) {
  const fieldByKey = new Map(lookups.fields.map((field) => [`${CUSTOM_PREFIX}${field.key}`, field]));
  return (
    <>
      {keys.map((key) => {
        switch (key) {
          case "amount":
            return (
              <p key={key} className="mt-0.5 text-md font-semibold tabular-nums">
                {formatMoney(deal.amountAgorot)}
              </p>
            );
          case "stuck":
            return stuck ? (
              <p key={key} className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-ink-soft">
                <Badge tone="warning">תקועה</Badge>
                <span>{stuck}</span>
              </p>
            ) : null;
          case "contact":
            return deal.contactId && deal.contactName ? (
              <p key={key} className="mt-0.5 text-sm">
                <Link href={paths.contact(orgId, deal.contactId)} draggable={false} className={linkClass}>
                  {deal.contactName}
                </Link>
              </p>
            ) : null;
          case "company":
            return deal.companyId && deal.companyName ? (
              <Line key={key} label="חברה">
                <Link href={paths.company(orgId, deal.companyId)} draggable={false} className={linkClass}>
                  {deal.companyName}
                </Link>
              </Line>
            ) : null;
          case "owner":
            return (
              <Line key={key} label="אחראי">
                {deal.ownerId ? (lookups.owners[deal.ownerId] ?? "משתמש שאינו בעסק") : "ללא אחראי"}
              </Line>
            );
          case "expected_close":
            return deal.expectedCloseDate ? (
              <Line key={key} label="צפי סגירה">
                <time dateTime={deal.expectedCloseDate}>{formatDate(deal.expectedCloseDate)}</time>
              </Line>
            ) : null;
          case "days_in_stage":
            return (
              <p key={key} className="mt-0.5 text-sm text-ink-soft">
                {daysInStageLabel(deal.daysInStage, formatNumber)}
              </p>
            );
          case "next_task":
            return (
              <Line key={key} label="המשימה הבאה">
                {deal.nextTask ? (
                  <>
                    {deal.nextTask.title}
                    {deal.nextTask.dueAt ? (
                      <>
                        {" · "}
                        <time dateTime={deal.nextTask.dueAt}>{formatDate(deal.nextTask.dueAt)}</time>
                      </>
                    ) : null}
                  </>
                ) : (
                  <span className="text-ink-soft">אין</span>
                )}
              </Line>
            );
          case "tags": {
            const tags = deal.tagIds
              .map((id) => ({ id, name: lookups.tags[id] }))
              .filter((tag): tag is { id: string; name: string } => Boolean(tag.name));
            return tags.length > 0 ? (
              <ul key={key} aria-label="תגיות" className="mt-1 flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <li key={tag.id}>
                    <Badge>{tag.name}</Badge>
                  </li>
                ))}
              </ul>
            ) : null;
          }
          case "competitor":
            return deal.competitor ? (
              <Line key={key} label="מתחרה">
                {deal.competitor}
              </Line>
            ) : null;
          case "loss_reason":
            return deal.lossReason?.name ? (
              <Line key={key} label="סיבת הפסד">
                {deal.lossReason.name}
              </Line>
            ) : null;
          default: {
            const field = fieldByKey.get(key);
            if (!field) return null;
            const shown = displayCustomFields([field], asCustomValues(deal.customFields))[0];
            if (!shown.text) return null;
            return (
              <Line key={key} label={field.label}>
                {shown.href ? (
                  <a href={shown.href} target="_blank" rel="noopener noreferrer" dir="ltr" draggable={false} className="break-all text-accent-strong underline underline-offset-4">
                    {shown.text}
                  </a>
                ) : (
                  <span dir={shown.ltr ? "ltr" : undefined}>{shown.text}</span>
                )}
              </Line>
            );
          }
        }
      })}
    </>
  );
}
