import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { paths } from "@/lib/paths";

import type { MergeType } from "../fields";
import { findDuplicateCandidates } from "../queries";

/**
 * On a record page, for those who may merge: records with the same phone, email
 * (or tax id), each with a link to the merge screen; and a way to pick another one.
 */
export async function DuplicatesCard({ orgId, type, id }: { orgId: string; type: MergeType; id: string }) {
  const candidates = await findDuplicateCandidates(orgId, type, id);
  if (candidates.length === 0) {
    return (
      <p className="text-sm">
        <Link href={paths.merge(orgId, type, id)} className="text-accent-strong underline underline-offset-4">
          מיזוג עם רשומה כפולה
        </Link>
      </p>
    );
  }
  return (
    <Card aria-labelledby="duplicates-title" className="border-warning/40">
      <CardHeader id="duplicates-title" title="כפילויות אפשריות" />
      <CardBody>
        <p className="mb-2 text-sm text-ink-soft">אותו טלפון, אימייל או ח.פ.:</p>
        <ul className="space-y-2">
          {candidates.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="block font-medium">{c.title}</span>
                {c.subtitle ? <span className="block text-sm text-ink-soft" dir="ltr">{c.subtitle}</span> : null}
              </span>
              <Link href={paths.merge(orgId, type, id, c.id)} className="text-sm font-medium text-accent-strong underline underline-offset-4">
                מיזוג<span className="sr-only"> עם {c.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
