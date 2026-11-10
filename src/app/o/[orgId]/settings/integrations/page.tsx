import type { Metadata } from "next";

import { ActionButton } from "@/components/action-button";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";
import { AVAILABILITY_LABELS, INTEGRATIONS_CATALOG, type CatalogAvailability } from "@/features/integrations/catalog";
import { TestConnectionForm } from "@/features/integrations/components/test-connection-form";
import { integrationEventText } from "@/features/integrations/event-text";
import { currentSecretKey } from "@/features/integrations/keys-server";
import { listIntegrationConnections, type IntegrationConnection } from "@/features/integrations/queries";
import { messageSendingSettingsPath } from "@/features/message-sending/paths";
import { setConnectionStatusAction } from "@/features/meta-leads/actions";
import { metaGraphProvider } from "@/features/meta-leads/graph/select";
import { metaLeadsSettingsPath } from "@/features/meta-leads/paths";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "אינטגרציות" };

type Props = { params: Promise<{ orgId: string }> };

const STATUS: Record<IntegrationConnection["status"], { label: string; tone: BadgeTone }> = {
  connected: { label: "מחובר", tone: "success" },
  pending: { label: "ממתין לטוקן", tone: "neutral" },
  disconnected: { label: "מנותק", tone: "neutral" },
  error: { label: "החיבור נפל", tone: "danger" },
};

const AVAILABILITY_TONE: Record<CatalogAvailability, BadgeTone> = { available: "accent", platform: "neutral", coming_soon: "neutral" };

const ERROR_TEXT: Record<string, string> = {
  token_invalid: "פייסבוק לא מקבלת את הטוקן. החליפו אותו בטוקן חדש של הדף.",
  page_taken: "הדף מחובר לעסק אחר במקסוז, ולכן לידים ממנו לא נכנסים כאן.",
  secret_unreadable: "לא הצלחנו לקרוא את הטוקן השמור. שמרו טוקן חדש.",
};

/**
 * INT-01 / INT-03: the integrations screen. A catalog by category (only Meta Lead Ads connects today; SMS goes through the
 * system's own account; email and payments are coming), then each connection of the business with its status, a test
 * against Meta, disconnecting, and its sync log. Owners and admins only; everything is read with the user's session.
 */
export default async function IntegrationsPage({ params }: Props) {
  const { orgId } = await params;
  const { org, role, canWrite } = await getOrgContext(orgId);
  if (!isAdminRole(role)) {
    return (
      <Card aria-labelledby="int-title">
        <CardHeader id="int-title" title="אינטגרציות" />
        <CardBody>
          <p className="text-md text-ink-soft">את החיבורים למערכות אחרות מנהלים בעלי העסק ומנהלי המערכת.</p>
        </CardBody>
      </Card>
    );
  }
  const [connections, metaInPlan] = await Promise.all([listIntegrationConnections(orgId), orgHasFeature(orgId, "meta_leads")]);
  const metaReady = metaGraphProvider() !== null && currentSecretKey() !== null;
  const when = new Intl.DateTimeFormat("he-IL", { timeZone: org?.timeZone, dateStyle: "short", timeStyle: "short" });
  const metaCount = connections.filter((c) => c.provider === "meta_lead_ads").length;

  return (
    <div className="space-y-6">
      <Card aria-labelledby="int-title">
        <CardHeader id="int-title" title="אינטגרציות" />
        <CardBody className="space-y-6">
          <p className="text-md text-ink-soft">
            כאן רואים לאילו מערכות העסק מחובר, אם החיבור עובד, ומה קרה בו לאחרונה. כשחיבור נופל, בעלי העסק ומנהלי המערכת מקבלים התראה.
          </p>
          {INTEGRATIONS_CATALOG.map((category) => (
            <section key={category.key} aria-labelledby={`int-cat-${category.key}`} className="space-y-3">
              <h3 id={`int-cat-${category.key}`} className="text-md font-medium">
                {category.label}
              </h3>
              <ul className="grid gap-3 sm:grid-cols-2">
                {category.items.map((item) => (
                  <li key={item.key} className="space-y-2 rounded-md border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-md font-medium">{item.name}</span>
                      <Badge tone={AVAILABILITY_TONE[item.availability]}>{AVAILABILITY_LABELS[item.availability]}</Badge>
                    </div>
                    <p className="text-sm text-ink-soft">{item.description}</p>
                    {item.provider === "meta_lead_ads" ? (
                      <p className="text-sm">
                        {!metaInPlan ? (
                          <span className="text-ink-soft">לא כלול בחבילה הנוכחית. </span>
                        ) : metaCount > 0 ? (
                          <span className="text-ink-soft">{metaCount === 1 ? "דף אחד מחובר. " : `${metaCount} דפים מחוברים. `}</span>
                        ) : null}
                        <TextLink href={metaLeadsSettingsPath(orgId)}>{metaCount > 0 ? "ניהול הדפים והטפסים" : "חיבור דף"}</TextLink>
                      </p>
                    ) : item.availability === "platform" ? (
                      <p className="text-sm">
                        <TextLink href={messageSendingSettingsPath(orgId)}>שם השולח ושעות השליחה</TextLink>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </CardBody>
      </Card>

      {connections.map((connection) => (
        <ConnectionCard
          key={connection.id}
          orgId={orgId}
          connection={connection}
          canWrite={canWrite}
          canTest={metaReady}
          when={when}
        />
      ))}
    </div>
  );
}

function ConnectionCard({
  orgId,
  connection,
  canWrite,
  canTest,
  when,
}: {
  orgId: string;
  connection: IntegrationConnection;
  canWrite: boolean;
  canTest: boolean;
  when: Intl.DateTimeFormat;
}) {
  const status = STATUS[connection.status];
  const titleId = `int-${connection.id}`;
  const problem = connection.status === "error" && connection.lastErrorCode ? (ERROR_TEXT[connection.lastErrorCode] ?? null) : null;
  return (
    <Card aria-labelledby={titleId}>
      <CardHeader id={titleId} title={`פייסבוק ואינסטגרם: ${connection.name}`} />
      <CardBody className="space-y-5">
        <div className="flex flex-wrap items-center gap-2 text-md">
          <Badge tone={status.tone}>{status.label}</Badge>
          {connection.externalId ? (
            <span className="text-sm text-ink-soft">
              מזהה הדף: <span dir="ltr">{connection.externalId}</span>
            </span>
          ) : null}
        </div>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-ink-soft">טוקן</dt>
            <dd className="text-md">{connection.secretSetAt ? `נשמר ב-${when.format(new Date(connection.secretSetAt))}` : "עוד לא נשמר"}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">אימות הדף</dt>
            <dd className="text-md">{connection.verifiedAt ? `אומת ב-${when.format(new Date(connection.verifiedAt))}` : "ממתין לליד הראשון"}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">פעולה אחרונה ביומן</dt>
            <dd className="text-md">{connection.events[0] ? when.format(new Date(connection.events[0].lastAt)) : "אין עדיין"}</dd>
          </div>
        </dl>
        {problem ? (
          <p role="status" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {problem}
          </p>
        ) : null}

        {canTest && canWrite && connection.provider === "meta_lead_ads" && connection.secretSetAt && (connection.status === "connected" || connection.status === "error") ? <TestConnectionForm orgId={orgId} integrationId={connection.id} /> : null}

        <div className="flex flex-wrap items-center gap-3">
          {canWrite && (connection.status === "connected" || connection.status === "error") ? (
            <ActionButton
              action={setConnectionStatusAction.bind(null, orgId, connection.id, false)}
              pendingText="מנתקים…"
              srLabel={connection.name}
              confirm="לנתק את הדף? לידים חדשים ממנו לא ייכנסו למערכת עד שתחברו אותו שוב."
              confirmLabel="ניתוק הדף"
            >
              ניתוק
            </ActionButton>
          ) : null}
          <TextLink href={metaLeadsSettingsPath(orgId)}>טוקן חדש, טפסים ומחיקת החיבור</TextLink>
        </div>

        <section aria-labelledby={`${titleId}-log`} className="space-y-2">
          <h3 id={`${titleId}-log`} className="text-md font-medium">
            יומן סנכרון
          </h3>
          {connection.events.length === 0 ? (
            <p className="text-sm text-ink-soft">אין עדיין רישומים ביומן.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {connection.events.map((event) => {
                const line = integrationEventText(event.kind, event.code, event.hits);
                return (
                  <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className={line.tone === "danger" ? "text-danger" : line.tone === "warning" ? "text-warning" : undefined}>{line.text}</span>
                    <time dateTime={event.lastAt} className="text-ink-soft">
                      {when.format(new Date(event.lastAt))}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-sm text-ink-soft">ביומן נרשמים רק סוג האירוע ושעתו, בלי פרטי לידים ובלי טוקנים. לידים שנקלטו באותו יום מוצגים בשורה אחת.</p>
        </section>
      </CardBody>
    </Card>
  );
}
