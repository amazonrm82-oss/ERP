import type { Metadata } from "next";
import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SelectField, TextareaField } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Tabs } from "@/components/ui/tabs";
import { PlatformForm } from "@/features/platform/components/platform-form";
import { canDo } from "@/features/platform/labels";
import { platformReady } from "@/features/platform/queries";
import { addSupportRequestNoteAction, setSupportRequestStatusAction } from "@/features/platform/support-actions";
import { listAdminSupportRequests } from "@/features/platform/support-queries";
import { SUPPORT_LIST_PAGE, supportStatusFilter } from "@/features/platform/support-requests";
import { SUPPORT_CATEGORIES, SUPPORT_STATUSES, supportStatusLabel, type SupportCategory } from "@/features/support-requests/categories";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "פניות תמיכה" };

const STATUS_TONES: Record<string, BadgeTone> = { open: "accent", in_progress: "warning", closed: "success" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const hrefFor = (status: string | null, page = 1) => {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return text ? `${paths.adminSupport}?${text}` : paths.adminSupport;
};

// ADM-05: the requests businesses send from the support form (USR-12). The platform owner and support read them
// (the customer wrote them to us, so no support session is needed: the page opens no business data), change the
// status (the requester is told) and add internal notes; every change is logged. Other platform roles do not see them.
export default async function AdminSupportPage({ searchParams }: Props) {
  const me = await platformReady();
  if (!me) return null;
  if (!canDo(me.role, ["support"])) {
    return (
      <>
        <PageHeader title="פניות תמיכה" />
        <p className="text-ink-soft">את הפניות רואים בעלי הפלטפורמה וצוות התמיכה בלבד.</p>
      </>
    );
  }
  const params = await searchParams;
  const status = supportStatusFilter(params.status);
  const page = Math.max(1, Math.floor(Number(params.page)) || 1);
  const list = await listAdminSupportRequests(status, page);

  return (
    <>
      <PageHeader title="פניות תמיכה" description="פניות שעסקים שלחו מתוך המערכת. שינוי מצב שולח לפונה התראה; הערה פנימית לא מגיעה לעסק." />
      <Tabs
        label="סינון לפי מצב"
        className="mb-5"
        items={[
          { href: hrefFor(null), label: "הכול", current: status === null, count: list.counts.open + list.counts.in_progress + list.counts.closed },
          ...(Object.keys(SUPPORT_STATUSES) as (keyof typeof SUPPORT_STATUSES)[]).map((key) => ({
            href: hrefFor(key),
            label: SUPPORT_STATUSES[key],
            current: status === key,
            count: list.counts[key],
          })),
        ]}
      />
      {list.rows.length === 0 ? (
        <p className="text-ink-soft">אין פניות כאן.</p>
      ) : (
        <ul className="space-y-4">
          {list.rows.map((request) => (
            <li key={request.id}>
              <Card className="space-y-3 px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-semibold break-words">{request.subject}</p>
                    <p className="text-sm text-ink-soft">
                      <Link href={paths.adminOrg(request.orgId)} className="text-accent-strong underline underline-offset-4">
                        {request.orgName}
                      </Link>
                      {" · "}
                      {request.requesterName ?? "משתמש"}
                      {request.requesterEmail ? (
                        <>
                          {" "}
                          <span dir="ltr">{request.requesterEmail}</span>
                        </>
                      ) : null}
                    </p>
                    <p className="text-sm text-ink-soft">
                      {SUPPORT_CATEGORIES[request.category as SupportCategory] ?? request.category} · {formatDateTime(request.createdAt)}
                      {request.pagePath ? (
                        <>
                          {" · דף: "}
                          <span dir="ltr" className="break-all">
                            {request.pagePath}
                          </span>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONES[request.status] ?? "neutral"}>{supportStatusLabel(request.status)}</Badge>
                </div>
                <p className="text-md break-words whitespace-pre-line">{request.message}</p>
                {request.notes.length > 0 ? (
                  <div className="space-y-2 rounded-md bg-canvas px-3 py-2">
                    <p className="text-sm font-medium">הערות פנימיות</p>
                    {request.notes.map((note) => (
                      <p key={note.id} className="text-sm break-words whitespace-pre-line">
                        <span className="text-ink-soft">
                          {formatDateTime(note.createdAt)} · {note.authorName ?? "צוות"}:
                        </span>{" "}
                        {note.body}
                      </p>
                    ))}
                  </div>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  <PlatformForm action={setSupportRequestStatusAction.bind(null, request.id)} submitLabel="עדכון מצב" className="space-y-3">
                    <SelectField label="מצב" name="status" defaultValue={request.status}>
                      {(Object.keys(SUPPORT_STATUSES) as (keyof typeof SUPPORT_STATUSES)[]).map((key) => (
                        <option key={key} value={key}>
                          {SUPPORT_STATUSES[key]}
                        </option>
                      ))}
                    </SelectField>
                  </PlatformForm>
                  <PlatformForm action={addSupportRequestNoteAction.bind(null, request.id)} submitLabel="הוספת הערה" className="space-y-3">
                    <TextareaField label="הערה פנימית" name="body" rows={2} maxLength={2000} required />
                  </PlatformForm>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={page} hasMore={page * SUPPORT_LIST_PAGE < list.total} hrefFor={(p) => hrefFor(status, p)} />
    </>
  );
}
