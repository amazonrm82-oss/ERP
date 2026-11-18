import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CloseIssueRequestButton, ConnectionButtons, InvoiceDefaultsForm } from "@/features/invoicing/components/invoicing-settings";
import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";
import { invoiceProviderEventText } from "@/features/invoicing/provider-events";
import { getInvoiceProviderEvents, getInvoicingAccess, getInvoicingSettings, getOpenIssueRequests } from "@/features/invoicing/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { formatDateTime, formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "ספק חשבוניות" };

type Props = { params: Promise<{ orgId: string }> };

// DOC-05: the business's connection to its invoice provider and the issue defaults. Hidden (not found) unless this deployment
// offers a provider (owner (270) (1) א: only the fake for now, never on the live site) and the plan holds `documents`.
export default async function InvoicingSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const access = await getInvoicingAccess(orgId);
  if (!access.offered || !access.inPlan) notFound();
  const [settings, openRequests, context] = await Promise.all([getInvoicingSettings(orgId), getOpenIssueRequests(orgId), getOrgContext(orgId)]);
  // DOC-16: owners and admins read the connection's sync log (RLS); nobody else is shown an empty one
  const showLog = isAdminRole(context.role);
  const events = showLog ? await getInvoiceProviderEvents(orgId) : [];
  const otherProvider = settings.connected && settings.provider !== access.offered;
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">
        מחברים את חשבון העסק אצל ספק החשבוניות, ואז מפיקים חשבוניות וקבלות ישירות מעסקה, מהצעה שאושרה, מהזמנה או מאיש קשר. המסמך נרשם במערכת עם המספר שהספק נתן לו.
      </p>
      <Card aria-labelledby="invoicing-connection">
        <CardHeader id="invoicing-connection" title={access.connected ? "מחובר לספק החשבוניות" : "לא מחובר"} />
        <CardBody className="space-y-3 text-sm">
          {access.offered === "fake" ? <p className="text-ink-soft">זהו ספק לבדיקות: הוא לא מפיק מסמכים אמיתיים.</p> : null}
          {settings.lastCheckAt ? (
            <p className="text-ink-soft">
              בדיקה אחרונה: {formatDateTime(settings.lastCheckAt)}, {settings.lastCheckOk ? "החיבור עבד" : "החיבור לא עבד"}.
            </p>
          ) : null}
          {otherProvider ? <p className="text-ink-soft">העסק מחובר לספק אחר, שאינו זמין כרגע. אפשר להתחבר מחדש לספק הזמין.</p> : null}
          {access.canManage ? (
            <ConnectionButtons orgId={orgId} connected={access.connected} />
          ) : (
            <p className="text-ink-soft">רק בעלים ומנהלי מערכת מחברים ומנתקים את ספק החשבוניות.</p>
          )}
        </CardBody>
      </Card>
      {openRequests.length > 0 ? (
        <Card aria-labelledby="invoicing-open-requests">
          <CardHeader id="invoicing-open-requests" title="בקשות הפקה שלא הסתיימו" />
          <CardBody className="space-y-3 text-sm">
            <p className="text-ink-soft">בקשות שנפתחו ולא נרשם בהן מסמך. בקשה שפתוחה יותר מיממה מסומנת &quot;ישנה&quot;, ובקשה שאולי הופקה אצל הספק בלי שנדע מסומנת &quot;לבדוק אצל הספק&quot;. לפני סגירה בודקים אצל הספק אם המסמך הופק.</p>
            <ul className="divide-y divide-line">
              {openRequests.map((request) => (
                <li key={request.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {request.docType && request.docType in DOCUMENT_TYPE_LABELS ? DOCUMENT_TYPE_LABELS[request.docType as keyof typeof DOCUMENT_TYPE_LABELS] : "מסמך"}
                    {request.totalAgorot !== null ? `, ${formatMoney(request.totalAgorot)}` : ""}, {formatDateTime(request.createdAt)}
                    {request.mine ? "" : request.requester ? `, ${request.requester}` : ""}
                    {request.status === "stale" ? " (ישנה)" : ""}
                    {request.status === "check" ? " (לבדוק אצל הספק)" : ""}
                  </span>
                  {/* DOC-14: a credit request that may exist at the provider is closed as checked by owners and admins only */}
                  {request.status === "check" && request.docType === "credit_invoice" && !access.canManage ? (
                    <span className="text-ink-soft">בעלים או מנהל מערכת סוגרים אותה</span>
                  ) : (
                    <CloseIssueRequestButton orgId={orgId} requestId={request.id} check={request.status === "check"} />
                  )}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
      {showLog ? (
        <Card aria-labelledby="invoicing-log">
          <CardHeader id="invoicing-log" title="יומן סנכרון" />
          <CardBody className="space-y-3 text-sm">
            {events.length === 0 ? (
              <p className="text-ink-soft">אין עדיין רישומים ביומן.</p>
            ) : (
              <ul className="divide-y divide-line rounded-md border border-line">
                {events.map((event) => {
                  const line = invoiceProviderEventText(event.kind, event.code, event.hits);
                  return (
                    <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className={line.tone === "danger" ? "text-danger" : line.tone === "warning" ? "text-warning" : undefined}>{line.text}</span>
                      <time dateTime={event.lastAt} className="text-ink-soft">
                        {formatDateTime(event.lastAt)}
                      </time>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-ink-soft">
              ביומן נרשמים רק סוג האירוע, הסיבה ושעתו, בלי פרטי לקוחות ובלי סכומים. אירועים מאותו סוג באותו יום מוצגים בשורה אחת, עם מספר הפעמים. כשהחיבור נופל, בעלים ומנהלי מערכת מקבלים התראה אחת ביום.
            </p>
          </CardBody>
        </Card>
      ) : null}
      <Card aria-labelledby="invoicing-defaults">
        <CardHeader id="invoicing-defaults" title="ברירות מחדל להפקה" />
        <CardBody>
          {access.canManage ? (
            <InvoiceDefaultsForm orgId={orgId} initial={{ defaultDocType: settings.defaultDocType, locale: settings.locale, sendEmail: settings.sendEmail }} />
          ) : (
            <p className="text-sm text-ink-soft">רק בעלים ומנהלי מערכת משנים את ברירות המחדל.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
