import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { isMergeType, TYPE_LABELS } from "@/features/merge/fields";
import { MergeForm } from "@/features/merge/components/merge-form";
import { MergePicker } from "@/features/merge/components/merge-picker";
import { loadMergePair } from "@/features/merge/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "מיזוג כפולים" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const RECORD_PATH = { lead: paths.lead, contact: paths.contact, company: paths.company } as const;

export default async function MergePage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const type = query.type;
  const keep = typeof query.keep === "string" ? query.keep : "";
  const merge = typeof query.merge === "string" ? query.merge : "";
  if (!isMergeType(type) || !isUuid(keep)) notFound();
  const { canDelete } = await getOrgContext(orgId);
  const back = { href: RECORD_PATH[type](orgId, keep), label: "חזרה לרשומה" };

  if (!canDelete) {
    return (
      <>
        <PageHeader title="מיזוג כפולים" back={back} />
        <p>מיזוג מותר לבעלים, למנהלי מערכת ולמנהלי צוות.</p>
      </>
    );
  }

  if (!isUuid(merge)) {
    return (
      <>
        <PageHeader title="מיזוג כפולים" description={`בחרו את הרשומה הכפולה (${TYPE_LABELS[type].one}), שתתמזג לרשומה הזו.`} back={back} />
        <Card className="max-w-xl">
          <CardBody>
            <MergePicker orgId={orgId} type={type} keepId={keep} />
          </CardBody>
        </Card>
      </>
    );
  }

  const pair = await loadMergePair(orgId, type, keep, merge);
  if (!pair) notFound();
  const [kept, dup] = pair;

  return (
    <>
      <PageHeader title="מיזוג כפולים" description={`${kept.title} ו-${dup.title} יהפכו לרשומה אחת.`} back={back} />
      <Card className="max-w-3xl" aria-labelledby="merge-title">
        <CardHeader
          id="merge-title"
          title={`נשארת: ${kept.title}`}
          action={
            <Link href={paths.merge(orgId, type, dup.id, kept.id)} className="text-sm text-accent-strong underline underline-offset-4">
              להשאיר את {dup.title} במקום
            </Link>
          }
        />
        <CardBody>
          <MergeForm orgId={orgId} type={type} keep={{ id: kept.id, title: kept.title, values: kept.values }} dup={{ id: dup.id, title: dup.title, values: dup.values }} />
        </CardBody>
      </Card>
    </>
  );
}
