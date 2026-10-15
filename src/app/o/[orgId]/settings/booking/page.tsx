import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { AddBookingPageButton, BookingPageList } from "@/features/booking/components/booking-pages-editor";
import { publicBookingPath } from "@/features/booking/paths";
import { listBookingPages, managedBookingReps, repHasHours } from "@/features/booking/queries";
import { getLeadLookups } from "@/features/leads/queries";
import { listMeetingTypeChoices } from "@/features/meeting-types/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { listMembers, orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { siteOrigin } from "@/lib/site-origin";

export const metadata: Metadata = { title: "דפי קביעת תור" };

type Props = { params: Promise<{ orgId: string }> };

/** CAL-10: public pages where customers book a meeting at a free time. Each person their own; owners and admins all; a team manager their people's. */
export default async function BookingPagesPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite, user } = await getOrgContext(orgId);
  const admin = isAdminRole(role);
  const manager = role === "manager";
  const [pages, types, lookups, members, origin, allowed] = await Promise.all([
    listBookingPages(orgId),
    listMeetingTypeChoices(orgId),
    getLeadLookups(orgId),
    admin || manager ? listMembers(orgId) : Promise.resolve([]),
    siteOrigin(),
    orgHasFeature(orgId, "booking_page"),
  ]);
  const managed = manager ? await managedBookingReps(orgId, user.id) : null;
  const hours = await repHasHours(orgId, [...new Set(pages.map((p) => p.userId))]);
  const noHours = hours.business ? [] : pages.map((p) => p.userId).filter((id) => !hours.people.has(id));
  const shared = {
    orgId,
    types: types.filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name })),
    sources: lookups.sources.filter((s) => s.isActive).map((s) => ({ id: s.id, name: s.name })),
    reps: admin
      ? members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ id: m.userId, name: m.name }))
      : managed && managed.size > 0
        ? members.filter((m) => m.status === "active" && m.role === "member" && managed.has(m.userId)).map((m) => ({ id: m.userId, name: m.name }))
        : null,
    linkBase: `${origin}${publicBookingPath("")}`,
  };

  return (
    <Card aria-labelledby="booking-pages-title">
      <CardHeader id="booking-pages-title" title="דפי קביעת תור" />
      <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
        <p>
          דף עם קישור שאפשר לשלוח ללקוחות: הם רואים זמנים פנויים לפי שעות העבודה והיומן, בוחרים זמן, ממלאים שם וטלפון, והפגישה נכנסת ליומן. מי
          שהטלפון שלו כבר במערכת מקושר לרשומה הקיימת; אחרים נרשמים כליד חדש.
        </p>
        <p>כל אחד מנהל את הדפים שלו, מנהל צוות גם את הדפים של אנשי הצוותים שלו, ובעלים ומנהלי מערכת רואים ומנהלים את כולם.</p>
      </CardBody>
      {!allowed ? (
        <CardBody className="mt-3 border-t border-line">
          <p className="text-md text-ink-soft">דפי קביעת תור אינם כלולים בחבילה הנוכחית.</p>
        </CardBody>
      ) : pages.length > 0 ? (
        <div className="mt-3 border-t border-line">
          <BookingPageList {...shared} pages={pages} noHours={noHours} editable={canWrite} />
        </div>
      ) : (
        <CardBody className="mt-3 border-t border-line">
          <p className="text-md text-ink-soft">{canWrite ? "עוד אין דפים. אפשר ליצור דף ראשון." : "אין דפים לתצוגה."}</p>
        </CardBody>
      )}
      {allowed && canWrite ? (
        <CardBody className="border-t border-line">
          <AddBookingPageButton {...shared} />
        </CardBody>
      ) : null}
    </Card>
  );
}
