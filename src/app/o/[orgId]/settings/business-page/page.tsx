import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { newBusinessPageLinkAction } from "@/features/business-page/actions";
import { listBookingPages } from "@/features/booking/queries";
import { BusinessPageEditor } from "@/features/business-page/components/business-page-editor";
import { publicBusinessPagePath } from "@/features/business-page/paths";
import { getBusinessPage, getBusinessPageSource } from "@/features/business-page/queries";
import { QrImage } from "@/features/intake/components/qr-image";
import { isAdminRole } from "@/features/settings/permissions";
import { listMembers, listTeams, orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgHours } from "@/features/work-hours/queries";
import { paths } from "@/lib/paths";
import { encodeQr } from "@/lib/qr";
import { siteOrigin } from "@/lib/site-origin";

export const metadata: Metadata = { title: "דף העסק" };

type Props = { params: Promise<{ orgId: string }> };

/**
 * BIZ-01: a public page for a business without a website: name, logo, a few words, phone, WhatsApp, website, working
 * hours, links to booking pages and a contact form whose inquiries come in as leads. Owners and admins only.
 */
export default async function BusinessPageSettings({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isAdminRole(role)) {
    return (
      <Card aria-labelledby="bizpage-title">
        <CardHeader id="bizpage-title" title="דף העסק" />
        <CardBody>
          <p className="text-md text-ink-soft">את דף העסק מגדירים בעלי העסק ומנהלי המערכת.</p>
        </CardBody>
      </Card>
    );
  }
  const [page, source, hours, bookingPages, inPlan, origin, members, teams] = await Promise.all([
    getBusinessPage(orgId),
    getBusinessPageSource(orgId),
    getOrgHours(orgId),
    listBookingPages(orgId),
    orgHasFeature(orgId, "public_page"),
    siteOrigin(),
    listMembers(orgId),
    listTeams(orgId),
  ]);
  const people = members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ id: m.userId, name: m.name }));
  const link = page ? `${origin}${publicBusinessPagePath(page.token)}` : null;

  return (
    <Card aria-labelledby="bizpage-title">
      <CardHeader id="bizpage-title" title="דף העסק" />
      <CardBody className="space-y-4">
        <p className="text-md text-ink-soft">
          דף ציבורי לעסק שאין לו אתר: שם העסק והלוגו, כמה מילים, חיוג, WhatsApp, שעות פעילות, קביעת תור וטופס פנייה שנכנס כליד. את הקישור
          שמים בפרופיל באינסטגרם, בגוגל או בחתימה.
        </p>
        <p className="text-sm text-ink-soft">
          הטלפון והאתר נלקחים מ
          <Link href={paths.settingsBusiness(orgId)} className="text-accent-strong underline-offset-2 hover:underline">
            פרטי העסק
          </Link>
          , והשעות משעות העבודה של העסק.
        </p>
        {!inPlan ? (
          <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
            דף עסק ציבורי אינו כלול בחבילה הנוכחית.
          </p>
        ) : null}
        {page && link ? (
          <div className="flex flex-wrap items-start gap-4 rounded-md border border-line bg-canvas p-3">
            <QrImage code={encodeQr(link)} label="קוד QR לדף העסק" className="aspect-square w-32 shrink-0 rounded" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-md">{page.isActive ? <Badge tone="success">פעיל</Badge> : <Badge>כבוי</Badge>}</p>
              <p className="text-sm break-all" dir="ltr">
                <Link href={publicBusinessPagePath(page.token)} className="text-accent-strong underline-offset-2 hover:underline" target="_blank">
                  {link}
                  <span className="sr-only"> (נפתח בחלון חדש)</span>
                </Link>
              </p>
              <p className="text-sm text-ink-soft">אפשר להעתיק את הקישור, או לצלם את הקוד ולהדפיס אותו.</p>
              {canWrite ? (
                <ConfirmButton
                  variant="secondary"
                  title="ליצור קישור חדש לדף העסק?"
                  description="הקישור הנוכחי וקודי ה-QR שהודפסו איתו יפסיקו לעבוד מיד. צריך להחליף אותם בכל מקום שבו פרסמתם אותם."
                  confirmLabel="יצירת קישור חדש"
                  action={newBusinessPageLinkAction.bind(null, orgId)}
                >
                  קישור חדש
                </ConfirmButton>
              ) : null}
            </div>
          </div>
        ) : null}
        {canWrite ? (
          <BusinessPageEditor
            orgId={orgId}
            page={page}
            bookingPages={bookingPages.map((b) => ({ id: b.id, title: b.title, repName: b.repName, isActive: b.isActive }))}
            source={{ phone: source.phone, website: source.website, hasHours: hours !== null && Object.keys(hours).length > 0 }}
            members={people}
            teams={teams.map((t) => ({ id: t.id, name: t.name }))}
          />
        ) : (
          <p className="text-md text-ink-soft">העסק במצב קריאה בלבד, ולכן אי אפשר לשנות את הדף כרגע.</p>
        )}
      </CardBody>
    </Card>
  );
}
