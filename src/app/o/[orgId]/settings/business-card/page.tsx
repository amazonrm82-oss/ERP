import type { Metadata } from "next";
import Link from "next/link";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { deleteCardAction } from "@/features/business-cards/actions";
import { CardEditor } from "@/features/business-cards/components/card-editor";
import { businessCardSettingsPath, publicCardPath } from "@/features/business-cards/paths";
import { listBusinessCards } from "@/features/business-cards/queries";
import { QrImage } from "@/features/intake/components/qr-image";
import { isAdminRole } from "@/features/settings/permissions";
import { listMembers, orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid } from "@/lib/paths";
import { encodeQr } from "@/lib/qr";
import { firstParam } from "@/lib/search";
import { siteOrigin } from "@/lib/site-origin";

export const metadata: Metadata = { title: "כרטיס ביקור" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * BIZ-02: a digital business card per rep: a link and a QR code, "save to contacts", and a "leave details" form whose
 * leads go to the rep. Each rep manages their own; owners and admins pick any rep (`?user=`).
 */
export default async function BusinessCardPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const { user, role, canWrite } = await getOrgContext(orgId);
  const admin = isAdminRole(role);
  const [cards, members, inPlan, origin] = await Promise.all([listBusinessCards(orgId), admin ? listMembers(orgId) : [], orgHasFeature(orgId, "business_card"), siteOrigin()]);

  const reps = members.filter((m) => m.status === "active" && m.role !== "viewer");
  const picked = firstParam(query.user);
  const userId = admin && isUuid(picked) && reps.some((m) => m.userId === picked) ? picked : user.id;
  const card = cards.find((c) => c.userId === userId) ?? null;
  const repName = userId === user.id ? null : (reps.find((m) => m.userId === userId)?.name ?? null);
  const link = card ? `${origin}${publicCardPath(card.token)}` : null;
  const editable = canWrite && role !== "viewer";

  return (
    <div className="space-y-6">
      <Card aria-labelledby="card-title">
        <CardHeader id="card-title" title={repName ? `כרטיס הביקור של ${repName}` : "כרטיס הביקור שלי"} />
        <CardBody className="space-y-4">
          <p className="text-md text-ink-soft">
            קישור וקוד QR לכרטיס ביקור דיגיטלי: הלקוח שומר אותך באנשי הקשר בטלפון, או משאיר פרטים, והפנייה נכנסת כליד שלך.
          </p>
          {!inPlan ? (
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              כרטיס ביקור דיגיטלי אינו כלול בחבילה הנוכחית.
            </p>
          ) : !editable ? (
            <p className="text-md text-ink-soft">כרטיס ביקור יש למשתמשים שעובדים עם לקוחות. אפשר לבקש מבעלי העסק לשנות את ההרשאה.</p>
          ) : (
            <>
              {card && link ? (
                <div className="flex flex-wrap items-start gap-4 rounded-md border border-line bg-canvas p-3">
                  <QrImage code={encodeQr(link)} label="קוד QR לכרטיס" className="aspect-square w-32 shrink-0 rounded" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="text-md">
                      {card.isActive ? <Badge tone="success">פעיל</Badge> : <Badge>כבוי</Badge>}
                    </p>
                    <p className="text-sm break-all" dir="ltr">
                      <Link href={publicCardPath(card.token)} className="text-accent-strong underline-offset-2 hover:underline" target="_blank">
                        {link}
                      </Link>
                    </p>
                    <p className="text-sm text-ink-soft">אפשר להעתיק את הקישור, או לצלם את הקוד ולהדפיס אותו.</p>
                  </div>
                </div>
              ) : null}
              <CardEditor key={userId} orgId={orgId} userId={userId} card={card} />
              {card ? (
                <ActionButton
                  action={deleteCardAction.bind(null, orgId, card.id)}
                  pendingText="מוחקים…"
                  variant="danger-ghost"
                  confirm="למחוק את הכרטיס? הקישור והקוד יפסיקו לעבוד. פניות ולידים שכבר נכנסו נשארים."
                  confirmLabel="מחיקת הכרטיס"
                >
                  מחיקת הכרטיס
                </ActionButton>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>

      {admin && inPlan ? (
        <Card aria-labelledby="cards-all">
          <CardHeader id="cards-all" title="הכרטיסים של כולם" />
          <ul className="divide-y divide-line border-t border-line">
            {reps.map((m) => {
              const own = cards.find((c) => c.userId === m.userId);
              return (
                <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
                  <span className="min-w-0 break-words">
                    {m.name} {own ? (own.isActive ? <Badge tone="success">פעיל</Badge> : <Badge>כבוי</Badge>) : <span className="text-sm text-ink-soft">· אין כרטיס</span>}
                  </span>
                  <Link href={`${businessCardSettingsPath(orgId)}?user=${m.userId}`} aria-current={m.userId === userId ? "page" : undefined} className="text-sm font-medium text-accent-strong underline-offset-2 hover:underline">
                    {own ? "עריכה" : "יצירה"}
                    <span className="sr-only">: {m.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
