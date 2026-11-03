import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { FIELD_OBJECTS, type FieldObject } from "@/features/custom-fields/types";
import { formatDayIn } from "@/features/lead-retention/model";
import { getRetentionStatus } from "@/features/lead-retention/queries";
import { retentionSettingsPath } from "@/features/lead-retention/paths";
import { getMemberPermissions } from "@/features/permissions/queries";
import { PrintButton } from "@/features/print/components/print-button";
import { PrintHeader } from "@/features/print/components/print-header";
import { PRIVACY_CLASS_LABELS } from "@/features/privacy-center/classes";
import { privacyWordingsPath } from "@/features/privacy-center/paths";
import { BUILT_IN_PERSONAL_FIELDS, OTHER_PERSONAL_DATA, type BuiltInPersonalField } from "@/features/privacy-center/personal-fields";
import { activeRoleCounts, markedFields, personalDataGrants, withoutSecondStep } from "@/features/privacy-center/summary";
import { NO_OFFICER, officerName, PRIVACY_OFFICER_EXPLAIN } from "@/features/privacy-officer/officer";
import { getPrivacyOfficerId } from "@/features/privacy-officer/queries";
import { isAdminRole, VISIBILITY_OPTIONS } from "@/features/settings/permissions";
import { getOrganizationSettings, listMembers, listMembersWithMfa, orgHasFeature } from "@/features/settings/queries";
import { ROLE_LABELS } from "@/features/shell/labels";
import { getOrgContext } from "@/features/shell/queries";
import { getOpenSupportGrant } from "@/features/support/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import type { OrgTerms } from "@/features/terminology/terms";
import { formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";
import { RECORD_TYPES } from "@/lib/record-types";

export const metadata: Metadata = { title: "מרכז פרטיות" };

type Props = { params: Promise<{ orgId: string }> };

function typeName(type: FieldObject, terms: OrgTerms): string {
  if (type === "company") return RECORD_TYPES.company.plural;
  return terms[type].plural;
}

function FieldItems({ items }: { items: readonly BuiltInPersonalField[] }) {
  return (
    <ul className="space-y-1 text-md">
      {items.map((item) => (
        <li key={item.label}>
          {item.label}
          {item.note ? <span className="text-sm text-ink-soft"> · {item.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

// PRK-01: one screen with what personal information the business keeps, who reaches it, the subprocessors and the
// retention policy; printable (GAP-11). Owners and admins only; privacy, so every plan. Everything is read with the
// user's session; the subprocessors are linked to their public page (no new service-key use).
export default async function PrivacyCenterPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  if (!isAdminRole(context.role)) {
    return <p className="text-sm text-ink-soft">רק בעלים ומנהלי מערכת רואים את מרכז הפרטיות.</p>;
  }
  const timeZone = context.org.timeZone;
  const [terms, fieldsByType, members, settings, grants, grantsOn, withMfa, retention, officerId, supportGrant] = await Promise.all([
    getOrgTerms(orgId),
    Promise.all(FIELD_OBJECTS.map((type) => listFieldDefinitions(orgId, type, { includeInactive: true }))),
    listMembers(orgId),
    getOrganizationSettings(orgId),
    getMemberPermissions(orgId),
    orgHasFeature(orgId, "granular_permissions"),
    listMembersWithMfa(orgId),
    getRetentionStatus(orgId),
    getPrivacyOfficerId(orgId),
    getOpenSupportGrant(orgId),
  ]);
  const roles = activeRoleCounts(members);
  const grantRows = grantsOn ? personalDataGrants(grants, members) : [];
  const visibility = VISIBILITY_OPTIONS.find((option) => option.value === settings?.recordVisibility);
  const noSecondStep = withoutSecondStep(members, withMfa);
  const officer = officerName(officerId, members);

  return (
    <div className="space-y-5">
      <PrintHeader orgName={context.org.name} timeZone={timeZone} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-soft">
          סיכום של המידע האישי שהעסק שומר במערכת, מי מגיע אליו ולכמה זמן. הסיכום עוזר לנהל את החובות לפי חוק הגנת הפרטיות, אבל
          לא מחליף ייעוץ משפטי.
        </p>
        <PrintButton label="הדפסת הסיכום" />
      </div>
      <h1 className="hidden text-2xl font-semibold print:block">מרכז פרטיות</h1>

      <Card aria-labelledby="privacy-officer">
        <CardHeader id="privacy-officer" title="אחראי פרטיות" />
        <CardBody className="space-y-2 text-md">
          <p className="font-medium">{officer ?? NO_OFFICER}</p>
          <p className="text-sm text-ink-soft">{PRIVACY_OFFICER_EXPLAIN}</p>
          <p className="text-sm print:hidden">
            <TextLink href={paths.settingsUsers(orgId)}>קביעת אחראי פרטיות במסך המשתמשים</TextLink>
          </p>
        </CardBody>
      </Card>

      <Card aria-labelledby="privacy-data">
        <CardHeader id="privacy-data" title="איזה מידע אישי נשמר" />
        <CardBody className="space-y-5">
          {FIELD_OBJECTS.map((type, index) => {
            const marked = markedFields(fieldsByType[index]);
            return (
              <section key={type} aria-labelledby={`privacy-data-${type}`} data-print-keep="" className="space-y-2">
                <h2 id={`privacy-data-${type}`} className="text-lead font-semibold">
                  {typeName(type, terms)}
                </h2>
                <FieldItems items={BUILT_IN_PERSONAL_FIELDS[type]} />
                {marked.length > 0 ? (
                  <ul className="space-y-1 text-md">
                    {marked.map((field) => (
                      <li key={field.label} className="flex flex-wrap items-center gap-2">
                        <span>{field.label}</span>
                        <Badge tone={field.privacyClass === "sensitive" ? "warning" : "neutral"}>{PRIVACY_CLASS_LABELS[field.privacyClass]}</Badge>
                        {field.isActive ? null : <span className="text-sm text-ink-soft">(מוסתר, הערכים נשמרים)</span>}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
          <section aria-labelledby="privacy-data-other" data-print-keep="" className="space-y-2">
            <h2 id="privacy-data-other" className="text-lead font-semibold">
              עוד מידע על אנשים
            </h2>
            <FieldItems items={OTHER_PERSONAL_DATA} />
          </section>
          <p className="text-sm text-ink-soft print:hidden">
            שדות שהוספתם מסמנים כמידע אישי או רגיש בכפתור &quot;עריכה&quot; של השדה, ב<TextLink href={paths.settingsFields(orgId)}>הגדרות השדות</TextLink>.
          </p>
        </CardBody>
      </Card>

      <Card aria-labelledby="privacy-access">
        <CardHeader id="privacy-access" title="מי מגיע למידע" />
        <CardBody className="space-y-4 text-md">
          <div>
            <h2 className="mb-1 font-semibold">משתמשים פעילים</h2>
            <ul className="space-y-1">
              {roles.map((row) => (
                <li key={row.role}>
                  {ROLE_LABELS[row.role]}: {formatNumber(row.count)}
                </li>
              ))}
            </ul>
          </div>
          <p>
            <span className="font-semibold">מי רואה אילו רשומות: </span>
            {visibility ? `${visibility.label}. ${visibility.description}` : "לא ידוע"} בעלים ומנהלי מערכת רואים הכול.
          </p>
          {grantRows.length > 0 ? (
            <div>
              <h2 className="mb-1 font-semibold">הרשאות נוספות שנוגעות למידע אישי</h2>
              <ul className="space-y-1">
                {grantRows.map((row) => (
                  <li key={row.key}>
                    {row.label}: {row.names.join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p>
            <span className="font-semibold">אימות דו-שלבי: </span>
            {settings?.requireMfa ? "חובה לכל המשתמשים בעסק." : "לא חובה בעסק."}{" "}
            {noSecondStep > 0 ? `${formatNumber(noSecondStep)} משתמשים פעילים עדיין בלי אימות דו-שלבי.` : "לכל המשתמשים הפעילים יש אימות דו-שלבי."}
          </p>
          <p>
            <span className="font-semibold">גישת תמיכה: </span>
            {supportGrant
              ? `צוות התמיכה של המערכת יכול לצפות בנתונים עד ${formatDayIn(supportGrant.expiresAt, timeZone)}, בצפייה בלבד.`
              : "אין גישה פתוחה לצוות התמיכה של המערכת. גישה כזו נפתחת רק באישור שלכם, לזמן קצוב."}
          </p>
        </CardBody>
      </Card>

      <Card aria-labelledby="privacy-subprocessors">
        <CardHeader id="privacy-subprocessors" title="קבלני משנה" />
        <CardBody className="space-y-2 text-md">
          <p>החברות שמספקות למערכת שירותים כמו אחסון ושליחה, ומה כל אחת מקבלת, מפורטות בדף ציבורי שמתעדכן כשהרשימה משתנה.</p>
          <p>
            <TextLink href={paths.legal("subprocessors")}>רשימת קבלני המשנה</TextLink>
            <span className="hidden print:inline" dir="ltr">
              {" "}
              ({paths.legal("subprocessors")})
            </span>
          </p>
        </CardBody>
      </Card>

      <Card aria-labelledby="privacy-retention">
        <CardHeader id="privacy-retention" title="מדיניות שמירה" />
        <CardBody className="space-y-2 text-md">
          <p>
            {retention.enabled && retention.months
              ? `פעילה: ${terms.lead.plural} בלי קשר ${formatNumber(retention.months)} חודשים עוברים לסל המחזור, ונמחקים סופית אחרי 30 יום.`
              : `כבויה: ${terms.lead.plural} נשמרים עד שמוחקים אותם.`}
          </p>
          {retention.last_round ? (
            <p className="text-sm text-ink-soft">
              בסבב האחרון ({formatDayIn(retention.last_round.finished_at, timeZone)}) עברו לסל המחזור {formatNumber(retention.last_round.binned)}.
            </p>
          ) : null}
          <p className="text-sm text-ink-soft">פניות מטפסים שהטופס שלהן נמחק נשמרות 12 חודשים. רשומה שנמחקת נשארת בסל המחזור 30 יום.</p>
          <p className="text-sm print:hidden">
            <TextLink href={retentionSettingsPath(orgId)}>הגדרת מדיניות השמירה</TextLink>
          </p>
        </CardBody>
      </Card>

      {/* PRK-04 */}
      <Card aria-labelledby="privacy-wordings" className="print:hidden">
        <CardHeader id="privacy-wordings" title="נוסחים מוכנים" />
        <CardBody className="text-md">
          <TextLink href={privacyWordingsPath(orgId)}>נוסח הסכמה לטפסים ופסקה להודעת הפרטיות של העסק</TextLink>
        </CardBody>
      </Card>
    </div>
  );
}
