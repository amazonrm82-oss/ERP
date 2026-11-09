import type { Metadata } from "next";
import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { canDo } from "@/features/platform/labels";
import { platformReady } from "@/features/platform/queries";
import { addRoadmapItemAction, updateRoadmapItemAction } from "@/features/platform/roadmap-actions";
import { listAdminRoadmap } from "@/features/platform/roadmap-queries";
import {
  ROADMAP_DESCRIPTION_MAX,
  ROADMAP_REQUESTS_MAX,
  ROADMAP_STATUS_LABELS,
  ROADMAP_STATUSES,
  ROADMAP_TITLE_MAX,
  adminListCutText,
  votesText,
  type AdminRoadmapItem,
  type RoadmapStatus,
} from "@/features/roadmap/items";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "מפת דרכים" };

const TONES: Record<RoadmapStatus, BadgeTone> = { building: "accent", planned: "neutral", done: "success" };

function ItemFields({ item }: { item?: AdminRoadmapItem }) {
  return (
    <>
      {item ? <input type="hidden" name="id" value={item.id} /> : null}
      <TextField label="כותרת" name="title" maxLength={ROADMAP_TITLE_MAX} required defaultValue={item?.title} hint="בנוסח שלנו. לא מעתיקים טקסט של לקוח." />
      <TextareaField label="תיאור קצר" name="description" maxLength={ROADMAP_DESCRIPTION_MAX} required defaultValue={item?.description} />
      <SelectField label="מצב" name="status" defaultValue={item?.status ?? "planned"}>
        {ROADMAP_STATUSES.map((status) => (
          <option key={status} value={status}>
            {ROADMAP_STATUS_LABELS[status]}
          </option>
        ))}
      </SelectField>
      <Checkbox name="published" defaultChecked={item?.published ?? false} label="מוצג לעסקים" hint="פריט שלא מוצג נשאר כאן בלבד." />
      <TextField label="סדר" name="sort_order" inputMode="numeric" dir="ltr" defaultValue={String(item?.sortOrder ?? 0)} hint="מספר קטן יותר מופיע קודם." />
      <TextareaField
        label="מזהי פניות לתמיכה"
        name="request_ids"
        dir="ltr"
        defaultValue={item?.requestIds?.join("\n")}
        hint={`לא חובה. מזהה פנייה בכל שורה, עד ${ROADMAP_REQUESTS_MAX}. רק הצוות רואה אותם; העסקים לא רואים פניות.`}
      />
    </>
  );
}

// TRU-01: the roadmap businesses see and vote on. Every platform role sees the list and the vote counts (never which
// business voted); the platform owner and support add and change items (logged, with two-step verification).
export default async function AdminRoadmapPage() {
  const me = await platformReady();
  if (!me) return null;
  const list = await listAdminRoadmap();
  const items = list.items;
  const cut = adminListCutText(list);
  const canEdit = canDo(me.role, ["support"]);

  return (
    <>
      <PageHeader
        title="מפת דרכים"
        description="מה בבנייה ומה מתוכנן, בנוסח שהצוות כתב. עסקים מצביעים מתוך המערכת: קול אחד לכל עסק בכל פריט. העמוד הציבורי באתר הוא רשימה קבועה בקוד."
      />
      <p className="mb-4 text-md">
        <Link href={paths.roadmap} className="text-accent-strong underline underline-offset-4">
          העמוד הציבורי
        </Link>
      </p>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card aria-labelledby="roadmap-list">
          <CardHeader id="roadmap-list" title="הפריטים" />
          {cut ? <p className="px-4 pt-3 text-sm text-ink-soft sm:px-5">{cut}</p> : null}
          {items.length === 0 ? (
            <p className="px-4 py-5 text-ink-soft sm:px-5">עוד אין פריטים.</p>
          ) : (
            <ul className="divide-y divide-line">
              {items.map((item) => (
                <li key={item.id} className="space-y-2 px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 font-medium break-words">{item.title}</p>
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <Badge tone={TONES[item.status]}>{ROADMAP_STATUS_LABELS[item.status]}</Badge>
                      <Badge tone={item.published ? "success" : "neutral"}>{item.published ? "מוצג" : "לא מוצג"}</Badge>
                    </div>
                  </div>
                  <p className="text-sm break-words whitespace-pre-line text-ink-soft">{item.description}</p>
                  <p className="text-sm text-ink-soft">
                    {votesText(item.votes)}
                    {item.requestIds && item.requestIds.length > 0 ? ` · ${item.requestIds.length.toLocaleString("he-IL")} פניות מקושרות` : null}
                  </p>
                  {canEdit ? (
                    <details>
                      <summary className="cursor-pointer text-sm text-accent-strong underline underline-offset-4">עריכה</summary>
                      <div className="pt-3">
                        <PlatformForm action={updateRoadmapItemAction} submitLabel="שמירת השינויים">
                          <ItemFields item={item} />
                        </PlatformForm>
                      </div>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {canEdit ? (
          <Card aria-labelledby="roadmap-new">
            <CardHeader id="roadmap-new" title="פריט חדש" />
            <CardBody>
              <PlatformForm action={addRoadmapItemAction} submitLabel="שמירה">
                <ItemFields />
              </PlatformForm>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
