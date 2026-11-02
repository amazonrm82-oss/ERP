import type { Metadata } from "next";
import { headers } from "next/headers";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { SUPPORT_CATEGORIES, supportPagePath, supportStatusLabel, type SupportCategory } from "@/features/support-requests/categories";
import { SupportForm } from "@/features/support-requests/components/support-form";
import { listSupportRequests } from "@/features/support-requests/queries";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { SUPPORT } from "@/lib/support";

export const metadata: Metadata = { title: "פנייה לתמיכה" };

const STATUS_TONES: Record<string, BadgeTone> = { open: "accent", in_progress: "warning", closed: "success" };

// USR-12: a support request from inside the business, and the requests already sent. Every member sends their own;
// owners and admins see every request of the business. The request reaches the platform's support (ADM-05).
export default async function SupportPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const requestHeaders = await headers();
  const from = supportPagePath(requestHeaders.get("referer"), requestHeaders.get("host"));
  const page = from === paths.support(orgId) ? null : from;
  const requests = await listSupportRequests(orgId);
  const admin = isAdminRole(context.role);
  const names = admin ? await getUserNames(requests.map((r) => r.userId)) : new Map<string, string>();
  // a support session reads; it never writes a request on the customer's behalf
  const canSend = !context.supportUntil;

  return (
    <>
      <PageHeader title="פנייה לתמיכה" description="כתבו לנו מה קרה או במה אפשר לעזור. הפנייה מגיעה לצוות התמיכה, ונעדכן אתכם כאן ובהתראה." />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          {canSend ? (
            <Card aria-labelledby="support-new">
              <CardHeader id="support-new" title="פנייה חדשה" />
              <CardBody>
                <SupportForm orgId={orgId} page={page} />
              </CardBody>
            </Card>
          ) : null}
          <Card aria-labelledby="support-list">
            <CardHeader id="support-list" title={admin ? "הפניות של העסק" : "הפניות שלי"} />
            {requests.length === 0 ? (
              <p className="px-4 py-5 text-ink-soft sm:px-5">עוד לא נשלחו פניות.</p>
            ) : (
              <ul className="divide-y divide-line">
                {requests.map((request) => (
                  <li key={request.id} className="space-y-1.5 px-4 py-3 sm:px-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 font-medium break-words">{request.subject}</p>
                      <Badge tone={STATUS_TONES[request.status] ?? "neutral"}>{supportStatusLabel(request.status)}</Badge>
                    </div>
                    <p className="text-sm text-ink-soft">
                      {SUPPORT_CATEGORIES[request.category as SupportCategory] ?? request.category} · {formatDateTime(request.createdAt)}
                      {admin && request.userId !== context.user.id ? ` · ${names.get(request.userId ?? "") ?? "משתמש שעזב"}` : ""}
                    </p>
                    <p className="text-sm break-words whitespace-pre-line">{request.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <Card aria-labelledby="support-direct">
          <CardHeader id="support-direct" title="דחוף?" />
          <CardBody className="space-y-2 text-md">
            <p>אפשר גם להתקשר או לשלוח הודעה:</p>
            <p>
              <a href={SUPPORT.telHref} className="text-accent-strong underline underline-offset-4">
                טלפון: <span dir="ltr">{SUPPORT.phone}</span>
              </a>
            </p>
            {SUPPORT.whatsappHref ? (
              <p>
                <a href={SUPPORT.whatsappHref} target="_blank" rel="noreferrer" className="text-accent-strong underline underline-offset-4">
                  WhatsApp
                  <span className="sr-only"> (נפתח בחלון חדש)</span>
                </a>
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
