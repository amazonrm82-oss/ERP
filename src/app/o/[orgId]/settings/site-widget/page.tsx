import type { Metadata } from "next";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopyBlock } from "@/features/intake/components/intake-editor";
import { isAdminRole } from "@/features/settings/permissions";
import { listMembers, listTeams, orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { deleteWidgetAction } from "@/features/site-widgets/actions";
import { WidgetEditor } from "@/features/site-widgets/components/widget-editor";
import { embedSnippet } from "@/features/site-widgets/model";
import { widgetScriptPath } from "@/features/site-widgets/paths";
import { listSiteWidgets } from "@/features/site-widgets/queries";
import { siteOrigin } from "@/lib/site-origin";

export const metadata: Metadata = { title: "כפתור באתר" };

type Props = { params: Promise<{ orgId: string }> };

/**
 * SPD-07: a floating button for the business's own website: WhatsApp, a call and a short form whose inquiries come in
 * as leads, with the page they came from. One line of code per site. Owners and admins only.
 */
export default async function SiteWidgetPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isAdminRole(role)) {
    return (
      <Card aria-labelledby="sw-title">
        <CardHeader id="sw-title" title="כפתור באתר" />
        <CardBody>
          <p className="text-md text-ink-soft">את הכפתור לאתר מנהלים בעלי העסק ומנהלי המערכת.</p>
        </CardBody>
      </Card>
    );
  }
  const [inPlan, widgets, members, teams, origin] = await Promise.all([
    orgHasFeature(orgId, "site_widget"),
    listSiteWidgets(orgId),
    listMembers(orgId),
    listTeams(orgId),
    siteOrigin(),
  ]);
  const people = members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ id: m.userId, name: m.name }));
  const teamOptions = teams.map((t) => ({ id: t.id, name: t.name }));
  const editable = inPlan && canWrite;

  return (
    <div className="space-y-6">
      <Card aria-labelledby="sw-title">
        <CardHeader id="sw-title" title="כפתור באתר" />
        <CardBody className="space-y-4">
          <p className="text-md text-ink-soft">
            כפתור צף באתר שלכם: WhatsApp, חיוג וטופס קצר. מי שממלא את הטופס נכנס כליד, עם הדף שממנו פנה ופרמטרי הקמפיין שלו. הכפתור לא שומר
            עוגיות ולא מזהה את הגולשים.
          </p>
          {!inPlan ? (
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              הכפתור הצף לאתר אינו כלול בחבילה הנוכחית.
            </p>
          ) : !canWrite ? (
            <p className="text-md text-ink-soft">העסק במצב קריאה בלבד, ולכן אי אפשר ליצור או לשנות כפתורים.</p>
          ) : (
            <WidgetEditor orgId={orgId} widget={null} members={people} teams={teamOptions} />
          )}
        </CardBody>
      </Card>

      {widgets.map((widget) => (
        <Card key={widget.id} aria-labelledby={`sw-${widget.id}`}>
          <CardHeader id={`sw-${widget.id}`} title={widget.name} />
          <CardBody className="space-y-4">
            <p className="text-md">{widget.isActive ? <Badge tone="success">פעיל</Badge> : <Badge>כבוי</Badge>}</p>
            <CopyBlock label="השורה לאתר (לפני התג ‎</body>‎)" value={embedSnippet(`${origin}${widgetScriptPath(widget.token)}`)} />
            {editable ? (
              <>
                <WidgetEditor orgId={orgId} widget={widget} members={people} teams={teamOptions} />
                <ActionButton
                  action={deleteWidgetAction.bind(null, orgId, widget.id)}
                  pendingText="מוחקים…"
                  variant="danger-ghost"
                  srLabel={widget.name}
                  confirm="למחוק את הכפתור? הוא יפסיק להופיע באתר, והטופס שלו ייסגר. לידים שכבר הגיעו נשארים."
                  confirmLabel="מחיקת הכפתור"
                >
                  מחיקת הכפתור
                </ActionButton>
              </>
            ) : null}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
