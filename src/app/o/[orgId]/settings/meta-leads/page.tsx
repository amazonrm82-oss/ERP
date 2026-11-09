import type { Metadata } from "next";

import { ActionButton } from "@/components/action-button";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { currentSecretKey } from "@/features/integrations/keys-server";
import { deleteConnectionAction, deleteFormMappingAction, setConnectionStatusAction } from "@/features/meta-leads/actions";
import { ConnectPageForm, ReplaceTokenForm } from "@/features/meta-leads/components/connect-page-form";
import { FormMappingEditor } from "@/features/meta-leads/components/form-mapping-editor";
import { metaGraphProvider } from "@/features/meta-leads/graph/select";
import { listMetaConnections, type MetaConnection } from "@/features/meta-leads/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { listMembers, listTeams, orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "לידים מפייסבוק ואינסטגרם" };

type Props = { params: Promise<{ orgId: string }> };

const STATUS: Record<MetaConnection["status"], { label: string; tone: BadgeTone }> = {
  connected: { label: "מחובר", tone: "success" },
  pending: { label: "ממתין לטוקן", tone: "neutral" },
  disconnected: { label: "מנותק", tone: "neutral" },
  error: { label: "פייסבוק לא מקבלת את הטוקן", tone: "danger" },
};

/**
 * CAP-11: Facebook and Instagram Lead Ads. Owners and admins connect a page (its token is stored encrypted, INT-02) and
 * say where each lead form's leads go. New leads arrive through Meta's webhook and are made through the same intake as
 * the lead forms, with the source "פייסבוק/אינסטגרם".
 */
export default async function MetaLeadsPage({ params }: Props) {
  const { orgId } = await params;
  const { org, role, canWrite } = await getOrgContext(orgId);
  if (!isAdminRole(role)) {
    return (
      <Card aria-labelledby="ml-title">
        <CardHeader id="ml-title" title="לידים מפייסבוק ואינסטגרם" />
        <CardBody>
          <p className="text-md text-ink-soft">את החיבור לפייסבוק ולאינסטגרם מנהלים בעלי העסק ומנהלי המערכת.</p>
        </CardBody>
      </Card>
    );
  }
  const [inPlan, connections, members, teams] = await Promise.all([
    orgHasFeature(orgId, "meta_leads"),
    listMetaConnections(orgId),
    listMembers(orgId),
    listTeams(orgId),
  ]);
  const people = members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ id: m.userId, name: m.name }));
  const teamOptions = teams.map((t) => ({ id: t.id, name: t.name }));
  const ready = metaGraphProvider() !== null && currentSecretKey() !== null;
  // CAP-11 (143) ב: without the plan key nothing new is connected or switched on; removing and switching off stay
  const editable = canWrite && inPlan;
  const when = new Intl.DateTimeFormat("he-IL", { timeZone: org?.timeZone, dateStyle: "short", timeStyle: "short" });

  return (
    <div className="space-y-6">
      <Card aria-labelledby="ml-title">
        <CardHeader id="ml-title" title="לידים מפייסבוק ואינסטגרם" />
        <CardBody className="space-y-4">
          <p className="text-md text-ink-soft">
            מי שממלא טופס לידים במודעה בפייסבוק או באינסטגרם נכנס למערכת כליד, עם המקור &quot;פייסבוק/אינסטגרם&quot; ושם הקמפיין. ליד שכבר
            נקלט לא נקלט פעם שנייה, וליד שהגיע בזמן תקלה נמשך שוב אוטומטית.
          </p>
          <p className="text-sm text-ink-soft">
            החיבור עובר דרך האפליקציה של מקסוז ב-Meta, שאנחנו מגדירים פעם אחת לכל העסקים. אין צורך להגדיר אצלכם כתובת Webhook: מספיק לחבר את הדף כאן.
          </p>
          {!inPlan ? (
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              קבלת לידים מפייסבוק ומאינסטגרם אינה כלולה בחבילה הנוכחית. בעלי העסק רואים את השימוש ב&quot;הגדרות &gt; חבילה ושימוש&quot;, ושם גם איך
              מגדילים את החבילה.
            </p>
          ) : !ready ? (
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              החיבור לפייסבוק ולאינסטגרם עוד לא הופעל במערכת. אפשר לראות את ההגדרות, ונעדכן כשיהיה אפשר לחבר דף.
            </p>
          ) : !canWrite ? (
            <p className="text-md text-ink-soft">העסק במצב קריאה בלבד, ולכן אי אפשר לחבר דפים או לשנות אותם.</p>
          ) : (
            <ConnectPageForm orgId={orgId} />
          )}
        </CardBody>
      </Card>

      {connections.map((connection) => {
        const status = STATUS[connection.status];
        const titleId = `ml-${connection.id}`;
        return (
          <Card key={connection.id} aria-labelledby={titleId}>
            <CardHeader id={titleId} title={connection.name} />
            <CardBody className="space-y-5">
              <div className="flex flex-wrap items-center gap-2 text-md">
                <Badge tone={status.tone}>{status.label}</Badge>
                <span className="text-sm text-ink-soft">
                  מזהה הדף: <span dir="ltr">{connection.pageId}</span>
                </span>
              </div>
              {connection.counts === null ? (
                <p className="text-sm text-ink-soft">
                  {connection.status === "error"
                    ? "לא הצלחנו לקלוט ממנו ליד. אם הדף שלכם, החליפו את הטוקן בטוקן של הדף."
                    : "ממתין לליד הראשון. כשליד מהדף ייקלט, החיבור יאומת והספירות יופיעו כאן."}
                </p>
              ) : (
                <ArrivalCounts counts={connection.counts} when={when} />
              )}
              {canWrite ? (
                <div className="space-y-3">
                  {ready && inPlan ? <ReplaceTokenForm orgId={orgId} integrationId={connection.id} /> : null}
                  <div className="flex flex-wrap gap-2">
                    {connection.status === "connected" || connection.status === "error" ? (
                      <ActionButton
                        action={setConnectionStatusAction.bind(null, orgId, connection.id, false)}
                        pendingText="מנתקים…"
                        srLabel={connection.name}
                        confirm="לנתק את הדף? לידים חדשים ממנו לא ייכנסו למערכת עד שתחברו אותו שוב."
                        confirmLabel="ניתוק הדף"
                      >
                        ניתוק הדף
                      </ActionButton>
                    ) : connection.status === "disconnected" && connection.secretSetAt ? (
                      <ActionButton action={setConnectionStatusAction.bind(null, orgId, connection.id, true)} pendingText="מחברים…" srLabel={connection.name}>
                        חיבור מחדש
                      </ActionButton>
                    ) : null}
                    <ActionButton
                      action={deleteConnectionAction.bind(null, orgId, connection.id)}
                      pendingText="מוחקים…"
                      variant="danger-ghost"
                      srLabel={connection.name}
                      confirm="למחוק את החיבור? הטוקן השמור וההגדרות של הטפסים יימחקו. לידים שכבר נקלטו נשארים."
                      confirmLabel="מחיקת החיבור"
                    >
                      מחיקת החיבור
                    </ActionButton>
                  </div>
                </div>
              ) : null}

              <section aria-labelledby={`${titleId}-forms`} className="space-y-4">
                <h3 id={`${titleId}-forms`} className="text-md font-medium">
                  טפסי הלידים של הדף
                </h3>
                {connection.forms.map((mapping) => (
                  <div key={mapping.id} className="space-y-3 rounded-md border border-line p-3">
                    <p className="text-md font-medium">
                      {mapping.name} {mapping.isActive ? null : <Badge>כבוי</Badge>}
                    </p>
                    {canWrite ? (
                      <>
                        <FormMappingEditor orgId={orgId} integrationId={connection.id} mapping={mapping} members={people} teams={teamOptions} />
                        {mapping.metaFormId !== null ? (
                          <ActionButton
                            action={deleteFormMappingAction.bind(null, orgId, mapping.id)}
                            pendingText="מוחקים…"
                            variant="danger-ghost"
                            srLabel={mapping.name}
                            confirm="להסיר את הטופס? לידים חדשים ממנו יעברו לפי ההגדרה של כל הטפסים בדף."
                            confirmLabel="הסרת הטופס"
                          >
                            הסרת הטופס
                          </ActionButton>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ))}
                {editable ? (
                  <details className="rounded-md border border-line p-3">
                    <summary className="cursor-pointer text-md font-medium">הוספת טופס עם הגדרה משלו</summary>
                    <div className="pt-3">
                      <FormMappingEditor orgId={orgId} integrationId={connection.id} mapping={null} members={people} teams={teamOptions} />
                    </div>
                  </details>
                ) : null}
              </section>
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}

function ArrivalCounts({ counts, when }: { counts: NonNullable<MetaConnection["counts"]>; when: Intl.DateTimeFormat }) {
  return (
    <>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-ink-soft">נקלטו (30 יום)</dt>
          <dd className="text-md font-medium">{counts.done}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">ממתינים למשיכה</dt>
          <dd className="text-md font-medium">{counts.pending}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">לא נקלטו (30 יום)</dt>
          <dd className="text-md font-medium">{counts.givenUp + counts.refused}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">ליד אחרון הגיע</dt>
          <dd className="text-md font-medium">{counts.lastReceivedAt ? when.format(new Date(counts.lastReceivedAt)) : "עוד לא"}</dd>
        </div>
      </dl>
      {counts.givenUp + counts.refused > 0 ? (
        <p className="text-sm text-ink-soft">
          ליד לא נקלט כשהטופס שלו כבוי, כשחסרים בו שם, טלפון ואימייל, או כשלא הצלחנו למשוך אותו במשך שלושה ימים.
        </p>
      ) : null}
    </>
  );
}
