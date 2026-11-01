import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Meter } from "@/components/ui/chart";

import { EDIT_PARAM, type CompletenessType } from "../completeness";
import { toCompletePath } from "../paths";
import { getRecordScore } from "../queries";

type Props = {
  orgId: string;
  type: CompletenessType;
  id: string;
  // the record's page, to which "?edit=<input>" is added; null when the user may not edit the record
  editBase: string | null;
};

const linkClass = "font-medium text-accent underline underline-offset-4 hover:text-accent-strong";

/** DQL-01: how many of the important fields are filled, and which are missing (each a link to edit it). */
export async function CompletenessCard({ orgId, type, id, editBase }: Props) {
  const score = await getRecordScore(orgId, type, id);
  if (!score) {
    return null;
  }
  const titleId = `completeness-${type}-title`;
  const done = score.missing.length === 0;

  return (
    <Card aria-labelledby={titleId}>
      <CardHeader id={titleId} title="השלמת פרטים" action={<span className="text-lg font-semibold tabular-nums">{score.score}%</span>} />
      <CardBody className="space-y-3">
        <Meter decorative value={score.score} max={100} tone={done ? "done" : "bar"} />
        {done ? (
          <p className="text-md text-ink-soft">כל השדות החשובים מלאים.</p>
        ) : (
          <div>
            <p className="text-sm text-ink-soft">חסר:</p>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-md">
              {score.missing.map((field) => (
                <li key={field.key}>
                  {editBase && field.formField ? (
                    <Link href={`${editBase}?${EDIT_PARAM}=${encodeURIComponent(field.formField)}`} scroll={false} className={linkClass}>
                      {field.label}
                    </Link>
                  ) : (
                    field.label
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-sm">
          <Link href={toCompletePath(orgId)} className={linkClass}>
            כל הרשומות להשלמה
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
