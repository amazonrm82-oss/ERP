import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import { ContactActions } from "@/components/contact-actions";
import type { WhatsappLog } from "@/features/whatsapp/templates";

export type RecordCardDetail = { text: string; title: string };

export type RecordCard = {
  id: string;
  href: string;
  title: string;
  // a status badge, first on the second line
  badge?: ReactNode;
  // short facts after it: company, city, owner; a fact with a title shows it on hover (a relative time's full date)
  details: Array<string | RecordCardDetail | null>;
  phone: string | null;
  phoneE164: string | null;
  // WA-01 follow-up: the WhatsApp templates for someone who can write (listWhatsappLog)
  whatsappLog?: WhatsappLog;
  // one more control on its own line under the card (SPD-01: "לקחתי" on a lead nobody owns)
  action?: ReactNode;
};

/**
 * A list on a phone (FXU-02): a card per record with its name, a badge and a
 * few facts, and call / WhatsApp in one tap. Lists show it below md and keep
 * their table above.
 */
export function RecordCards({ label, cards, className }: { label: string; cards: RecordCard[]; className?: string }) {
  return (
    <ul aria-label={label} className={className}>
      {cards.map((card) => (
        <li key={card.id} className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface py-2.5 ps-4 pe-2.5">
          <Link href={card.href} className="min-w-0 flex-1 py-1">
            <span className="block truncate font-medium text-ink">{card.title}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft">
              {card.badge}
              {card.details.some(Boolean) ? (
                <span className="min-w-0 truncate">
                  {card.details
                    .filter((detail): detail is string | RecordCardDetail => Boolean(detail))
                    .map((detail, index) => (
                      <Fragment key={index}>
                        {index > 0 ? " · " : null}
                        {typeof detail === "string" ? detail : <span title={detail.title}>{detail.text}</span>}
                      </Fragment>
                    ))}
                </span>
              ) : null}
            </span>
          </Link>
          <ContactActions phone={card.phone} phoneE164={card.phoneE164} email={null} compact={{ name: card.title }} whatsappLog={card.whatsappLog} />
          {card.action ? <div className="basis-full">{card.action}</div> : null}
        </li>
      ))}
    </ul>
  );
}
