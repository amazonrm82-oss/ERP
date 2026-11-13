import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";
import { MarketingSmsDetailsNotice } from "@/features/message-sending/components/marketing-sms-details-notice";
import { getMarketingSmsMissing } from "@/features/message-sending/queries";
import { messageTemplatesPath } from "@/features/message-templates/paths";
import { ReviewRequestSettingsForm } from "@/features/review-requests/components/review-request-settings-form";
import { getReviewRequestSettings, hasActiveReviewTemplate } from "@/features/review-requests/queries";
import { REVIEW_REQUEST_GAP_DAYS } from "@/features/review-requests/review-url";
import { reviewDealWonLabel, reviewHowItWorks, reviewOnlySince } from "@/features/review-requests/texts";
import { qrExternalBlocked } from "@/features/qr-codes/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { sendingPauseSettingsPath } from "@/features/sending-pause/paths";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { SUPPORT } from "@/lib/support";

export const metadata: Metadata = { title: "בקשת ביקורת" };

type Props = { params: Promise<{ orgId: string }> };

// RET-02: a request for a review (Google, Facebook, easy, Zap or any https link; owner (307) ב) after a won deal or a held meeting. Everyone reads; owners and admins change.
export default async function ReviewRequestSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const [{ role, canWrite }, settings, inPlan, hasTemplate, externalOff, smsInPlan, smsMissing, terms] = await Promise.all([
    getOrgContext(orgId),
    getReviewRequestSettings(orgId),
    orgHasFeature(orgId, "review_requests"),
    hasActiveReviewTemplate(orgId),
    qrExternalBlocked(orgId),
    orgHasFeature(orgId, "sms"),
    getMarketingSmsMissing(orgId),
    getOrgTerms(orgId),
  ]);
  // RVW-89: a review request by SMS carries the marketing sender line, which needs the business's address and phone
  const smsDetails = inPlan && smsInPlan ? <MarketingSmsDetailsNotice orgId={orgId} missing={smsMissing} /> : null;
  const editable = isAdminRole(role) && canWrite;
  // review (8): on, but nothing to send from (the templates were switched off or deleted)
  const noTemplate =
    settings.enabled && !hasTemplate ? (
      <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
        אין תבנית פעילה לבקשת ביקורת, ולכן לא נשלחות בקשות. הפעילו את התבנית &quot;בקשת ביקורת&quot; ב
        <TextLink href={messageTemplatesPath(orgId)}>תבניות ההודעה</TextLink>.
      </p>
    ) : null;
  // review (1): the platform's outside-link switch (BIZ-03) stops review requests too
  const externalNotice = externalOff ? (
    <p role="status" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
      הקישורים החיצוניים של העסק כובו על ידי צוות המערכת, ולכן לא נשלחות בקשות ביקורת ואי אפשר להפעיל אותן או לשנות את הקישור. לפרטים פנו
      לתמיכה בטלפון <span dir="ltr">{SUPPORT.phone}</span>.
    </p>
  ) : null;

  const rules = (
    <Card aria-labelledby="review-requests-rules-title">
      <CardHeader id="review-requests-rules-title" title="איך זה עובד" />
      <CardBody className="space-y-3 text-sm">
        <p>{reviewHowItWorks(terms, REVIEW_REQUEST_GAP_DAYS)}</p>
        <p>
          כל לקוח מקבל את אותה הבקשה. המערכת לא שואלת קודם אם הלקוח מרוצה ולא בוחרת למי לשלוח לפי זה, כי הכללים של Google אוסרים לבקש ביקורות רק
          מלקוחות מרוצים.
        </p>
        <p>
          זו הודעה שיווקית: היא נשלחת רק למי שהסכים לקבל הודעות שיווקיות בערוץ הזה, עם המילה &quot;פרסומת&quot;, פרטי העסק ודרך להסרה. היא נספרת בתקרת
          הודעות השיווק, יוצאת רק בשעות השליחה, ולא יוצאת בזמן ש<TextLink href={sendingPauseSettingsPath(orgId)}>השליחה ללקוחות עצורה</TextLink>.
        </p>
        <p>
          {reviewOnlySince(terms)} את הנוסח משנים ב<TextLink href={messageTemplatesPath(orgId)}>תבניות ההודעה</TextLink>{" "}
          (&quot;בקשת ביקורת&quot;); תבנית שכובתה לא נשלחת.
        </p>
        {inPlan ? null : <p className="text-ink-soft">בקשת ביקורת לא כלולה בחבילה של העסק, ולכן לא נשלחות בקשות.</p>}
      </CardBody>
    </Card>
  );

  if (editable) {
    return (
      <div className="space-y-5">
        {externalNotice}
        {noTemplate}
        {smsDetails}
        <ReviewRequestSettingsForm orgId={orgId} settings={settings} inPlan={inPlan} dealWonLabel={reviewDealWonLabel(terms)} />
        {rules}
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {externalNotice}
      {noTemplate}
      {smsDetails}
      <Card aria-labelledby="review-requests-title">
        <CardHeader id="review-requests-title" title="בקשת ביקורת מלקוחות" />
        <CardBody>
          <DetailList>
            <Detail label="מצב" value={settings.enabled ? "פועל" : "כבוי"} />
            <Detail label="מתי" value={[settings.onDealWon ? "אחרי עסקה שנסגרה" : null, settings.onMeetingHeld ? "אחרי פגישה" : null].filter(Boolean).join(", ") || "לא נבחר"} />
            <Detail label="כמה ימים אחרי" value={String(settings.delayDays)} />
          </DetailList>
          <p className="mt-4 text-sm text-ink-soft">
            {isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות."}
          </p>
        </CardBody>
      </Card>
      {rules}
    </div>
  );
}
