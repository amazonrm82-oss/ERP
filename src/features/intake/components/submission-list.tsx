import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";

import type { SubmissionItem } from "../queries";

type Item = SubmissionItem & { formName?: string };

/** The rows of a submission log: who wrote in, when, and what came of it. */
export function SubmissionList({ orgId, submissions }: { orgId: string; submissions: Item[] }) {
  return (
    <ul className="divide-y divide-line">
      {submissions.map((submission) => (
        <li key={submission.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
          <span className="min-w-0">
            {submission.leadId ? (
              <Link href={paths.lead(orgId, submission.leadId)} className="font-medium break-words underline-offset-4 hover:underline">
                {submission.summary}
              </Link>
            ) : (
              <span className="font-medium break-words text-ink-soft">{submission.summary}</span>
            )}
            <span className="block text-sm text-ink-soft">
              {submission.formName ? <>{submission.formName} · </> : null}
              {formatDateTime(submission.createdAt)}
            </span>
          </span>
          {submission.status === "spam" ? (
            <Badge tone="warning">ספאם, לא נוצר ליד</Badge>
          ) : submission.status === "duplicate" ? (
            <Badge tone="accent">פנייה חוזרת, נוספה לרשומה קיימת</Badge>
          ) : submission.leadId ? (
            <Badge tone="success">ליד נוצר</Badge>
          ) : (
            <Badge>הליד נמחק</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}
