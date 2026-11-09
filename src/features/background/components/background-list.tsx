import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { formatDateTime, formatNumber } from "@/lib/format";

import { backgroundDownloadPath } from "../paths";
import type { BackgroundRequestRow } from "../queries";
import { BACKGROUND_FILE_DAYS, BACKGROUND_STATUS_LABEL } from "../rules";
import { CancelBackgroundButton } from "./background-buttons";

const OPEN = new Set(["awaiting_file", "queued", "running"]);

/** IMP-04: the person's own background imports and exports, with the export's download while it is kept. */
export function BackgroundList({ orgId, rows }: { orgId: string; rows: BackgroundRequestRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Card aria-labelledby="background-title">
      <CardHeader id="background-title" title="עבודות ברקע" />
      <ul className="divide-y divide-line">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 sm:px-5">
            <div className="min-w-0">
              <p className="font-medium break-words">{row.kind === "export" ? "ייצוא מלא" : `ייבוא: ${row.fileName ?? ""}`}</p>
              <p className="mt-0.5 text-sm text-ink-soft">
                {formatDateTime(row.createdAt)} · {BACKGROUND_STATUS_LABEL[row.status] ?? row.status}
              </p>
              {row.kind === "import" && row.totalRows ? (
                <p className="mt-0.5 text-sm">
                  {formatNumber(row.rowsDone)} מתוך {formatNumber(row.totalRows)} שורות · נוצרו {formatNumber(row.counts.created)}, עודכנו{" "}
                  {formatNumber(row.counts.updated)}, דולגו {formatNumber(row.counts.skipped)}, נכשלו {formatNumber(row.counts.failed)}
                </p>
              ) : null}
              {row.message ? <p className="mt-0.5 text-sm">{row.message}</p> : null}
              {row.downloadable && row.fileExpiresAt ? (
                <p className="mt-0.5 text-sm text-ink-soft">
                  הקובץ נשמר {BACKGROUND_FILE_DAYS} ימים, עד {formatDateTime(row.fileExpiresAt)}.
                </p>
              ) : null}
            </div>
            {row.downloadable ? (
              <a href={backgroundDownloadPath(orgId, row.id)} className={buttonClasses("secondary", "sm")}>
                הורדה
              </a>
            ) : OPEN.has(row.status) ? (
              <CancelBackgroundButton orgId={orgId} requestId={row.id} />
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
