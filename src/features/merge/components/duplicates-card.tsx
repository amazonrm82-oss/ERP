import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { UniqueClashNote } from "@/features/data-quality/components/unique-clash-note";
import { findUniqueFieldClashes } from "@/features/data-quality/duplicates";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import type { MergeType } from "../fields";
import { findDuplicateCandidates } from "../queries";

/**
 * On a record page: for those who may merge, records with the same phone, email
 * (or tax id), each with a link to the merge screen, and a way to pick another one.
 * For everyone who reads the record (FLD-07): a value of a unique field that
 * another record holds, with a link to it when they may open it.
 */
export async function DuplicatesCard({ orgId, type, id, canMerge }: { orgId: string; type: MergeType; id: string; canMerge: boolean }) {
  const [candidates, clashes] = await Promise.all([
    canMerge ? findDuplicateCandidates(orgId, type, id) : Promise.resolve([]),
    createClient().then((supabase) => findUniqueFieldClashes(supabase, orgId, type, [id])),
  ]);
  if (candidates.length === 0 && clashes.length === 0) {
    if (!canMerge) return null;
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
      <CardBody className="space-y-3">
        {clashes.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {clashes.map((clash) => (
              <li key={`${clash.label}-${clash.other?.href ?? ""}`}>
                <UniqueClashNote clash={clash} />
              </li>
            ))}
          </ul>
        ) : null}
        {candidates.length > 0 ? <p className="text-sm text-ink-soft">אותו טלפון, אימייל או ח.פ.:</p> : null}
        {candidates.length > 0 ? (
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
        ) : null}
        {canMerge && candidates.length === 0 ? (
          <Link href={paths.merge(orgId, type, id)} className="text-sm text-accent-strong underline underline-offset-4">
            מיזוג עם רשומה כפולה
          </Link>
        ) : null}
      </CardBody>
    </Card>
  );
}
