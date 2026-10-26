import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { InboxIcon } from "@/components/ui/icons";
import { AddSourceForm, AddStatusForm, SourceList, StatusList } from "@/features/customization/components/lead-settings-editor";
import { listLeadSettings } from "@/features/customization/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "סטטוסים ומקורות" };

type Props = { params: Promise<{ orgId: string }> };

export default async function LeadSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const { statuses, sources } = await listLeadSettings(orgId);

  return (
    <div className="space-y-5">
      <Card aria-labelledby="statuses-title">
        <CardHeader id="statuses-title" title="סטטוסים של לידים" />
        <CardBody className="pb-0 text-md text-ink-soft">
          הסדר כאן הוא הסדר ברשימות. &quot;הומר&quot; נקבע אוטומטית כשממירים ליד, ו&quot;לא רלוונטי&quot; מבקש סיבה. סטטוס שיש בו
          לידים אי אפשר למחוק.
        </CardBody>
        {statuses.length > 0 ? (
          <div className="mt-3 border-t border-line">
            <StatusList orgId={orgId} statuses={statuses} editable={editable} />
          </div>
        ) : (
          <EmptyState
            compact
            icon={<InboxIcon />}
            title="עוד אין סטטוסים"
            description={editable ? "סטטוס מראה באיזה שלב נמצא כל ליד. מוסיפים סטטוס ראשון בטופס שלמטה." : "סטטוס מראה באיזה שלב נמצא כל ליד."}
            className="mt-3 border-t border-line"
          />
        )}
        {editable ? (
          <CardBody className="border-t border-line">
            <AddStatusForm orgId={orgId} />
          </CardBody>
        ) : null}
      </Card>

      <Card aria-labelledby="sources-title">
        <CardHeader id="sources-title" title="מקורות לידים" />
        <CardBody className="pb-0 text-md text-ink-soft">
          מקור מוסתר נשאר על הלידים הקיימים, אבל לא מוצע יותר בטפסים.
        </CardBody>
        {sources.length > 0 ? (
          <div className="mt-3 border-t border-line">
            <SourceList orgId={orgId} sources={sources} editable={editable} />
          </div>
        ) : (
          <EmptyState
            compact
            icon={<InboxIcon />}
            title="עוד אין מקורות"
            description={editable ? "מקור מראה מאיפה הגיע כל ליד. מוסיפים מקור ראשון בטופס שלמטה." : "מקור מראה מאיפה הגיע כל ליד."}
            className="mt-3 border-t border-line"
          />
        )}
        {editable ? (
          <CardBody className="border-t border-line">
            <AddSourceForm orgId={orgId} />
          </CardBody>
        ) : null}
      </Card>
    </div>
  );
}
