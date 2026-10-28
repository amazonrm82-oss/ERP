import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";

import { promiseState } from "../promise";

/** COL-03: the promise on a document: its date, whether it was kept, and the collection note. */
export function PromiseLine({
  date,
  note,
  today,
  customer = false,
}: {
  date: string;
  note: string | null;
  today: string;
  customer?: boolean;
}) {
  const broken = promiseState(date, today) === "broken";
  return (
    <p className="text-sm break-words">
      <Badge tone={broken ? "danger" : "accent"}>
        {broken ? "הבטחה שלא קוימה" : customer ? "הבטחת הלקוח" : "הבטחת תשלום"}
      </Badge>{" "}
      <span className="text-ink-soft">
        {customer
          ? "הלקוח התחייב לשלם את החובות שלו עד "
          : "הלקוח התחייב לשלם עד "}
        {formatDate(`${date}T12:00:00Z`)}
      </span>
      {note ? (
        <>
          <span className="text-ink-soft">{": "}</span>
          <bdi>{note}</bdi>
        </>
      ) : null}
    </p>
  );
}
