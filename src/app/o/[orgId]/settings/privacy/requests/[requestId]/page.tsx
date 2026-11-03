import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";
import { PersonEraseButton } from "@/features/privacy-erase/components/person-erase-button";
import { PersonExportLink } from "@/features/privacy-export/components/person-export-link";
import { LinkForm, RefuseForm, StatusForm, VerifyForm } from "@/features/privacy-requests/components/request-handling";
import { isClosed, isOverdue, nextStatuses, REQUEST_TYPE_LABELS, STATUS_LABELS, targetLine, VERIFY_METHOD_LABELS } from "@/features/privacy-requests/model";
import { privacyRequestPath, privacyRequestsPath } from "@/features/privacy-requests/paths";
import { getPrivacyRequest, linkedRecordName } from "@/features/privacy-requests/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { formatDate, formatDateTime, zoneDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "בקשת פרטיות" };

type Props = { params: Promise<{ orgId: string; requestId: string }> };

const day = (date: string) => formatDate(`${date}T12:00:00Z`);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

// PRK-02: one request: what was asked, the identity check, the record it is about, and the execution through the existing
// PRV-02 person export and PRV-03 person erasure of that record (no new deletion logic). Owners and admins only.
export default async function PrivacyRequestPage({ params }: Props) {
  const { orgId, requestId } = await params;
  if (!isUuid(requestId)) notFound();
  const context = await getOrgContext(orgId);
  if (!isAdminRole(context.role)) {
    return <p className="text-sm text-ink-soft">רק בעלים ומנהלי מערכת רואים בקשות פרטיות.</p>;
  }
  const row = await getPrivacyRequest(orgId, requestId);
  if (!row) notFound();
  const [terms, members, recordName] = await Promise.all([getOrgTerms(orgId), listMembers(orgId), linkedRecordName(orgId, row)]);
  const today = zoneDate(new Date(), context.org.timeZone);
  const closed = isClosed(row.status);
  const verified = row.verified_at !== null;
  const overdue = isOverdue(row.status, row.target_date, today);
  const line = targetLine(row.status, row.target_date, today);
  const nameOf = (userId: string | null) => (userId ? (members.find((m) => m.userId === userId)?.name ?? "משתמש שעזב") : "");
  const linkKind: "lead" | "contact" = row.lead_id ? "lead" : "contact";
  const linkedId = row.lead_id ?? row.contact_id;
  const linkedGone = !linkedId && row.former_lead_ids.length + row.former_contact_ids.length > 0;
  const writable = context.canWrite;
  const kindName = linkKind === "lead" ? terms.lead.singular : terms.contact.singular;

  return (
    <div className="space-y-5">
      <p className="text-sm">
        <TextLink href={privacyRequestsPath(orgId)}>כל הבקשות</TextLink>
      </p>

      <Card aria-labelledby="privacy-request">
        <CardHeader id="privacy-request" title={REQUEST_TYPE_LABELS[row.request_type]} />
        <CardBody className="space-y-4 text-md">
          <div className="flex flex-wrap gap-2">
            <Badge tone={closed ? "neutral" : "accent"}>{STATUS_LABELS[row.status]}</Badge>
            {overdue ? <Badge tone="danger">באיחור</Badge> : null}
          </div>
          <dl className="space-y-3">
            <Row label="שם">{row.requester_name ?? "הפרטים נמחקו (מחיקת פרטיות)"}</Row>
            <Row label={row.contact_kind === "email" ? "אימייל" : "טלפון"}>
              {row.contact_value ? <bdi dir="ltr">{row.contact_value}</bdi> : "—"}
            </Row>
            {row.details ? (
              <Row label="פרטים">
                <span className="whitespace-pre-wrap">{row.details}</span>
              </Row>
            ) : null}
            <Row label="התקבלה">{formatDateTime(row.received_at)}</Row>
            <Row label="מועד יעד">
              {day(row.target_date)}
              {line ? <span className={overdue ? "text-danger" : "text-ink-soft"}> · {line}</span> : null}
            </Row>
            {row.closed_at ? (
              <Row label="נסגרה">
                {formatDateTime(row.closed_at)}
                {row.closed_by ? ` · ${nameOf(row.closed_by)}` : ""}
              </Row>
            ) : null}
            {row.refusal_reason ? <Row label="סיבת הדחייה">{row.refusal_reason}</Row> : null}
          </dl>
          {!closed && writable ? <StatusForm orgId={orgId} requestId={row.id} options={nextStatuses(row.status, verified)} /> : null}
        </CardBody>
      </Card>

      <Card aria-labelledby="privacy-request-verify">
        <CardHeader id="privacy-request-verify" title="אימות זהות" />
        <CardBody className="space-y-3 text-md">
          {verified ? (
            <p>
              הזהות אומתה: {row.verify_method ? VERIFY_METHOD_LABELS[row.verify_method] : ""} · {formatDateTime(row.verified_at)} · {nameOf(row.verified_by)}
              {row.verify_note ? <span className="block text-sm text-ink-soft">{row.verify_note}</span> : null}
            </p>
          ) : closed ? (
            <p className="text-ink-soft">הזהות לא אומתה.</p>
          ) : (
            <>
              <p className="text-sm text-ink-soft">
                לפני שמוסרים מידע, מתקנים או מוחקים, מוודאים שהבקשה באמת של האדם, למשל בשיחה למספר ששמור אצלכם. רק אחרי הסימון אפשר
                להעביר את הבקשה לטיפול.
              </p>
              {writable ? <VerifyForm orgId={orgId} requestId={row.id} status={row.status} /> : null}
            </>
          )}
        </CardBody>
      </Card>

      <Card aria-labelledby="privacy-request-record">
        <CardHeader id="privacy-request-record" title="הרשומה והביצוע" />
        <CardBody className="space-y-4 text-md">
          {linkedId ? (
            <p>
              קשורה ל{kindName}:{" "}
              <TextLink href={linkKind === "lead" ? paths.lead(orgId, linkedId) : paths.contact(orgId, linkedId)}>{recordName ?? kindName}</TextLink>
            </p>
          ) : linkedGone ? (
            <p>הבקשה כבר לא קשורה לרשומה (הקישור הוסר, או שהרשומה נמחקה).</p>
          ) : (
            <p className="text-ink-soft">הבקשה עוד לא קשורה לרשומה. אם אין במערכת מידע על האדם, עונים לו על כך וסוגרים את הבקשה.</p>
          )}
          {!closed && writable ? (
            <LinkForm
              orgId={orgId}
              requestId={row.id}
              kind={linkKind}
              current={linkedId ? { id: linkedId, label: recordName ?? kindName } : null}
              leadLabel={terms.lead.singular}
              contactLabel={terms.contact.singular}
            />
          ) : null}
          {linkedId && !closed ? (
            verified && row.status === "in_progress" ? (
              <div className="space-y-2 border-t border-line pt-3">
                <p className="text-sm text-ink-soft">
                  {row.request_type === "erasure"
                    ? "המחיקה נעשית בכלי מחיקת האדם: היא מסירה את הרשומה ואת מה שקשור אליה, ומוחקת את הפרטים מהבקשה הזו. אחרי הביצוע מסמנים שהבקשה טופלה."
                    : row.request_type === "access"
                      ? "הקובץ מכיל את כל המידע על האדם. שלחו אותו לאדם בדרך מאובטחת, ואחר כך סמנו שהבקשה טופלה."
                      : "מתקנים את הפרטים בכרטיס הרשומה, ואחר כך מסמנים שהבקשה טופלה."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <PersonExportLink orgId={orgId} kind={linkKind} id={linkedId} />
                  {row.request_type === "erasure" && writable ? (
                    <PersonEraseButton orgId={orgId} kind={linkKind} id={linkedId} listHref={privacyRequestPath(orgId, row.id)} />
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-soft">הביצוע נפתח אחרי אימות הזהות, כשהבקשה במצב &quot;בטיפול&quot;.</p>
            )
          ) : null}
        </CardBody>
      </Card>

      {!closed && writable ? (
        <Card aria-labelledby="privacy-request-refuse">
          <CardHeader id="privacy-request-refuse" title="דחיית הבקשה" />
          <CardBody className="space-y-3">
            <p className="text-sm text-ink-soft">למשל כשלא ניתן לאמת את הזהות, או בקשה לא רצינית. הבקשה נסגרת ולא נמחקת, והסיבה נשמרת איתה.</p>
            <RefuseForm orgId={orgId} requestId={row.id} />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
