import type { Metadata } from "next";

import { ActionButton } from "@/components/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { markNotificationsReadAction } from "@/features/notifications/actions";
import { NotificationList } from "@/features/notifications/components/notification-list";
import { PushToggle } from "@/features/notifications/components/push-toggle";
import { listNotifications } from "@/features/notifications/queries";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "התראות" };

const SHOWN = 100;

export default async function NotificationsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { user } = await getOrgContext(orgId);
  const items = await listNotifications(orgId, user.id, SHOWN);
  const hasUnread = items.some((item) => !item.read);

  return (
    <>
      <PageHeader
        title="התראות"
        description="הקצאות, פניות חוזרות, תזכורות למשימות והודעות מאוטומציות."
        actions={
          hasUnread ? (
            <ActionButton action={markNotificationsReadAction.bind(null, orgId, null)} pendingText="מסמן…">
              סימון הכל כנקרא
            </ActionButton>
          ) : null
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card aria-labelledby="notifications-list">
          <CardHeader id="notifications-list" title="אחרונות" />
          {items.length === 0 ? (
            <EmptyState title="אין התראות" description="כשליד או משימה יוקצו לך, או כשתגיע תזכורת, זה יופיע כאן." />
          ) : (
            // key: a fresh list after "mark all read"
            <NotificationList key={items.map((item) => `${item.id}${item.read ? 1 : 0}`).join()} orgId={orgId} items={items} />
          )}
        </Card>
        <Card aria-labelledby="notifications-push" className="order-first lg:order-none">
          <CardHeader id="notifications-push" title="התראות לנייד ולמחשב" />
          <CardBody className="space-y-3">
            <p className="text-sm text-ink-soft">כל התראה כאן תקפוץ גם בטלפון או במחשב, גם כשהמערכת סגורה. ההגדרה היא לכל דפדפן בנפרד.</p>
            <PushToggle orgId={orgId} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
