import type { ComponentType, SVGProps } from "react";

import {
  BellIcon,
  BoardIcon,
  BoltIcon,
  ChartIcon,
  ChatIcon,
  BuildingIcon,
  CalendarIcon,
  CheckSquareIcon,
  FormIcon,
  InboxIcon,
  LockIcon,
  PencilIcon,
  TagIcon,
  TrashIcon,
  UploadIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { anomalyAlertSettingsPath } from "@/features/anomaly-alerts/paths";
import { bookingPagesPath } from "@/features/booking/paths";
import { businessCardSettingsPath } from "@/features/business-cards/paths";
import { businessPageSettingsPath } from "@/features/business-page/paths";
import { calendarSettingsPath } from "@/features/calendar-days/paths";
import { cardLayoutSettingsPath } from "@/features/card-layout/paths";
import { consentBlocklistPath } from "@/features/consent-blocklist/paths";
import { conversionMapSettingsPath } from "@/features/conversion-map/paths";
import { leadScoreSettingsPath } from "@/features/lead-score/paths";
import { retentionSettingsPath } from "@/features/lead-retention/paths";
import { privacyCenterPath } from "@/features/privacy-center/paths";
import { privacyRequestsPath } from "@/features/privacy-requests/paths";
import { meetingTypesPath } from "@/features/meeting-types/paths";
import { priceListsPath } from "@/features/price-lists/paths";
import { detachedQuotesPath, quoteDesignPath, quoteTemplatesPath } from "@/features/quotes/paths";
import { detachedSignatureDocumentsPath } from "@/features/signatures/paths";
import { productListsSettingsPath } from "@/features/products/paths";
import { siteWidgetSettingsPath } from "@/features/site-widgets/paths";
import { metaLeadsSettingsPath } from "@/features/meta-leads/paths";
import { integrationsSettingsPath } from "@/features/integrations/paths";
import { qrCodesSettingsPath } from "@/features/qr-codes/paths";
import { completenessSettingsPath } from "@/features/data-quality/paths";
import { documentSettingsPath } from "@/features/tax/paths";
import { numberingSettingsPath } from "@/features/numbering/paths";
import { responseSettingsPath } from "@/features/response-target/paths";
import { customerStatusSettingsPath } from "@/features/customer-status/paths";
import { punchCardSettingsPath } from "@/features/punch-cards/paths";
import { distributionSettingsPath } from "@/features/lead-distribution/paths";
import { whatsappTemplatesPath } from "@/features/whatsapp/paths";
import { messageTemplatesPath } from "@/features/message-templates/paths";
import { documentTemplatesPath } from "@/features/document-templates/paths";
import { checklistTemplatesPath } from "@/features/task-checklists/paths";
import { activityTypesPath } from "@/features/activity-types/paths";
import { modulesSettingsPath } from "@/features/modules/paths";
import { sendingPauseSettingsPath } from "@/features/sending-pause/paths";
import { messageSendingSettingsPath } from "@/features/message-sending/paths";
import { reviewRequestSettingsPath } from "@/features/review-requests/paths";
import { termsSettingsPath } from "@/features/terminology/paths";
import { canEditCatalog, canImportWith, canManageAutomations } from "@/features/permissions/keys";
import { isAdminRole } from "@/features/settings/permissions";
import type { MembershipRole } from "@/lib/database.types";
import { paths } from "@/lib/paths";

export type SettingsSection = {
  href: string;
  label: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
};

export type SettingsGroup = { label: string; sections: SettingsSection[] };

export type SettingsAccess = {
  // owners and admins: customization, intake, automations, audit
  admin: boolean;
  // the import and export page: owners, admins and team managers who can write (app.can_import),
  // a member with the import permission (PRM-01), and the owner in every state for the full export (BIL-09)
  canImport: boolean;
  // owners, admins and team managers (recycle bin)
  canDelete: boolean;
  // PL-01: the plan holds the 'price_lists' capability (orgHasFeature); without it the section is hidden
  priceLists?: boolean;
  // PRM-01: owners and admins, or a member with the extra permission (edit_catalog / manage_automations)
  catalog?: boolean;
  automations?: boolean;
  // QUO-07 (owner, 18 October 2026): owners, admins and managers by role read the kept quotes of deleted customers
  keptQuotes?: boolean;
  // PKG-03: the plan holds the 'punch_cards' capability; without it the punch card alerts section is hidden
  punchCards?: boolean;
};

/**
 * Who sees which settings section, from the person's role, the business's state and the plan (the settings page, its
 * side list and REC-09's command palette all ask this once, so they never disagree).
 */
export function settingsAccessFor(input: {
  role: MembershipRole;
  canWrite: boolean;
  canDelete: boolean;
  priceLists: boolean;
  punchCards?: boolean;
  granted: readonly string[];
}): SettingsAccess {
  const { role, canWrite, canDelete, priceLists, punchCards = false, granted } = input;
  const admin = isAdminRole(role);
  return {
    admin,
    // owners, admins and team managers import (app.can_import), and a member with the import permission (PRM-01); the
    // owner also exports in read-only
    canImport: (canWrite && canImportWith(role, granted)) || role === "owner",
    canDelete,
    priceLists,
    punchCards,
    catalog: canEditCatalog(role, granted),
    automations: canManageAutomations(role, granted),
    keptQuotes: admin || role === "manager",
  };
}

/**
 * The settings area as one list in four groups (FXU-13), shared by the
 * settings page, the side list on a computer and the page titles.
 * "החשבון שלי" is personal and lives in the user menu.
 */
export function settingsGroups(orgId: string, access: SettingsAccess): SettingsGroup[] {
  const groups: SettingsGroup[] = [
    {
      label: "העסק",
      sections: [
        { href: paths.settingsBusiness(orgId), label: "פרטי העסק", description: "שם, ענף, טלפון, אבטחה וגישת תמיכה", icon: BuildingIcon },
        { href: paths.settingsUsers(orgId), label: "משתמשים", description: "הזמנת עובדים, תפקידים והרשאות", icon: UsersIcon },
        { href: paths.settingsTeams(orgId), label: "צוותים", description: "מנהל צוות רואה את הרשומות של הצוות שלו", icon: UsersIcon },
        { href: calendarSettingsPath(orgId), label: "שעות וימי מנוחה", description: "שעות העבודה של העסק, הימים שהוא לא עובד בהם והחגים", icon: CalendarIcon },
        // CAL-08: everyone reads the list; owners and admins edit it
        { href: meetingTypesPath(orgId), label: "סוגי פגישה", description: "משך, מיקום, מרווח וצבע לכל סוג של פגישה", icon: CalendarIcon },
        { href: documentSettingsPath(orgId), label: 'מע"מ ופרטים למסמכים', description: 'המעמד במע"מ, והפרטים שמופיעים בהצעות ובמסמכים', icon: FormIcon },
        // CON-11: everyone reads it; owners and admins change it
        { href: customerStatusSettingsPath(orgId), label: "סטטוס לקוח", description: "אחרי כמה חודשים בלי קנייה לקוח נחשב רדום, ואחרי כמה לשעבר", icon: UsersIcon },
        // PKG-03: everyone reads it; owners and admins change it. Hidden without the capability.
        ...(access.punchCards
          ? [{ href: punchCardSettingsPath(orgId), label: "כרטיסיות", description: "מתי כרטיסייה מתריעה שנשארו מעט כניסות או שהתוקף מתקרב", icon: BellIcon }]
          : []),
        // QUO-03: everyone reads it; owners and admins change it
        { href: numberingSettingsPath(orgId), label: "מספור הצעות והזמנות", description: "קידומת ומספר התחלתי למספרים של הצעות מחיר והזמנות", icon: FormIcon },
        // QUO-04: everyone reads the templates; owners and admins rename and delete them
        { href: quoteTemplatesPath(orgId), label: "תבניות הצעת מחיר", description: "הצעות שמורות עם שורות ותנאים, להתחלה מהירה", icon: FormIcon },
        // QUO-05: everyone sees it; owners and admins change it
        { href: quoteDesignPath(orgId), label: "עיצוב הצעת מחיר", description: "לוגו, צבע, כותרות, פרטי העסק ופרטי הבנק בהצעה, בהזמנה ובדף החשבון ללקוח", icon: FormIcon },
        // PL-01: everyone reads the price lists; owners and admins edit them. Hidden without the capability.
        // QUO-07: kept quotes whose deal and contact were purged; owners, admins and managers by role read them
        ...(access.keptQuotes ?? access.admin
          ? [{ href: detachedQuotesPath(orgId), label: "הצעות של לקוחות שנמחקו", description: "הצעות שנשלחו ונשארו אחרי שהלקוח נמחק לצמיתות", icon: FormIcon }]
          : []),
        // SGN-02 (235) ב: documents for signature whose record was purged; the same readers
        ...(access.keptQuotes ?? access.admin
          ? [{ href: detachedSignatureDocumentsPath(orgId), label: "מסמכים ללא רשומה", description: "מסמכים לחתימה שנשארו אחרי שהרשומה שלהם נמחקה לצמיתות", icon: FormIcon }]
          : []),
        ...(access.priceLists
          ? [{ href: priceListsPath(orgId), label: "מחירונים", description: "מחירים אחרים או הנחות לחלק מהמוצרים, לתקופה מסוימת", icon: TagIcon }]
          : []),
        ...(access.admin
          ? [
              { href: paths.settingsPlan(orgId), label: "חבילה ושימוש", description: "החבילה, ימי הניסיון והשימוש מול כל מכסה", icon: ChartIcon },
              // HEB-09
              { href: sendingPauseSettingsPath(orgId), label: "עצירת שליחה ללקוחות", description: "ביום אבל או בחירום: עוצרים בלחיצה אחת כל שליחה אוטומטית ללקוחות", icon: BellIcon },
              // MSG-05/MSG-06: everyone reads the hours; owners and admins change them and see the usage; CAL-12: meeting messages
              { href: messageSendingSettingsPath(orgId), label: "שעות ותקרות שליחה", description: "באילו שעות יוצאות הודעות ללקוחות, כמה הודעות שיווק בחודש, ואישור ותזכורות פגישה ללקוח", icon: BellIcon },
              // RET-02: everyone may read it; owners and admins change it (the page says when the plan lacks it)
              { href: reviewRequestSettingsPath(orgId), label: "בקשת ביקורת", description: "הודעה ללקוח עם קישור לביקורת ב-Google, אחרי עסקה שנסגרה או פגישה", icon: ChatIcon },
              { href: paths.settingsSetupChecklist(orgId), label: "רשימת הקמה", description: "מה כבר מוכן בעסק, ונתוני דוגמה", icon: CheckSquareIcon },
            ]
          : []),
      ],
    },
    {
      label: "התאמה אישית",
      sections: [
        ...(access.admin
          ? [
              // FLD-10
              { href: termsSettingsPath(orgId), label: "מונחים", description: "איך העסק קורא לאנשי קשר, ללידים ולעסקאות", icon: PencilIcon },
              // LEAD-08
              { href: modulesSettingsPath(orgId), label: "מודולים", description: "כיבוי הלידים או החברות לעסק שלא עובד איתם", icon: BoltIcon },
              { href: paths.settingsPipelines(orgId), label: "תהליכי מכירה", description: "שלבי המכירה של העסקאות", icon: BoardIcon },
              { href: paths.settingsDealLossReasons(orgId), label: "סיבות הפסד", description: "הרשימה שבוחרים ממנה כשעסקה אבודה", icon: BoardIcon },
              // CON-03 follow-up
              { href: paths.settingsDealContactRoles(orgId), label: "תפקידים בעסקה", description: "התפקידים של אנשי הקשר בעסקה", icon: BoardIcon },
              // CON-06
              { href: paths.settingsContactRelationTypes(orgId), label: "קשרים בין אנשי קשר", description: "בן/בת זוג, הורה, מי הפנה את מי", icon: BoardIcon },
            ]
          : []),
        // PRD-04; PRM-01: also for a member with the catalog permission
        ...(access.admin || access.catalog
          ? [{ href: productListsSettingsPath(orgId), label: "קטגוריות ויחידות מידה", description: "הרשימות שבוחרים מהן בכל מוצר בקטלוג", icon: TagIcon }]
          : []),
        ...(access.admin
          ? [
              { href: paths.settingsLeads(orgId), label: "סטטוסים ומקורות", description: "השלבים של ליד ומאיפה הוא הגיע", icon: InboxIcon },
              { href: paths.settingsDisqualifyReasons(orgId), label: "סיבות לליד לא רלוונטי", description: "הרשימה שבוחרים ממנה כשליד לא רלוונטי", icon: InboxIcon },
              { href: paths.settingsRecordTypes(orgId), label: "סוגי אנשי קשר וחברות", description: "לקוח, ספק, שותף: הרשימה שבוחרים ממנה וסוננים לפיה", icon: UsersIcon },
              { href: paths.settingsFields(orgId), label: "שדות", description: "שדות משלכם בכרטיסים ובטפסים", icon: PencilIcon },
              // FLD-08
              { href: cardLayoutSettingsPath(orgId), label: "תצוגת כרטיס", description: "קבוצות של שדות בכרטיס של כל רשומה, בסדר שלכם", icon: FormIcon },
              { href: conversionMapSettingsPath(orgId), label: "שדות בהמרת ליד", description: "לאיזה שדה של איש קשר ועסקה עובר כל שדה של ליד", icon: InboxIcon },
              { href: completenessSettingsPath(orgId), label: "שדות חשובים", description: "מה חשוב למלא בכל רשומה, ומה חסר", icon: CheckSquareIcon },
              { href: paths.settingsTags(orgId), label: "תגיות", description: "סימון רשומות וסינון לפיהן", icon: TagIcon },
              { href: whatsappTemplatesPath(orgId), label: "תבניות WhatsApp", description: "הודעות מוכנות שנפתחות מכרטיס הרשומה", icon: ChatIcon },
              // MSG-02
              { href: messageTemplatesPath(orgId), label: "תבניות הודעה", description: "נוסחים משותפים לאימייל, SMS ו-WhatsApp, עם שדות מיזוג", icon: ChatIcon },
              // SGN-01
              { href: documentTemplatesPath(orgId), label: "תבניות מסמך", description: "חוזה, הסכם שירות, טופס הצטרפות: נוסחים עם שדות מהרשומה", icon: FormIcon },
              // TASK-06
              { href: checklistTemplatesPath(orgId), label: "תבניות רשימת תיוג", description: "רשימות שלבים קבועות שנכנסות למשימה, כמו קליטת לקוח", icon: CheckSquareIcon },
              // TASK-08
              { href: activityTypesPath(orgId), label: "סוגי פעילות ומשימה", description: "ביקור, הדגמה: השמות שבוחרים מהם בתיעוד ובמשימות", icon: CheckSquareIcon },
            ]
          : []),
      ],
    },
    {
      label: "לידים ואוטומציות",
      sections: [
        ...(access.admin
          ? [{ href: paths.settingsIntake(orgId), label: "טפסים וחיבורים", description: "טפסים, קישור לשיתוף וחלוקת לידים", icon: FormIcon }]
          : []),
        // PRM-01: also for a member with the automations permission
        ...(access.admin || access.automations
          ? [{ href: paths.settingsAutomations(orgId), label: "אוטומציות", description: "פעולות שקורות לבד, בלי לזכור", icon: BoltIcon }]
          : []),
        // CAP-08: everyone reads it; owners and admins change it
        { href: distributionSettingsPath(orgId), label: "חלוקת לידים", description: "סבב, משקל, עומס פתוח, וכללים לפי מקור ומוצר", icon: UsersIcon },
        // CAP-10: everyone reads it; owners and admins change it
        { href: responseSettingsPath(orgId), label: "יעד זמן תגובה", description: "תוך כמה זמן עונים לליד חדש, ומה קורה כשלא", icon: BellIcon },
        // MNY-04 (285) ג: owners and admins switch each anomaly alert and set its number
        ...(access.admin
          ? [{ href: anomalyAlertSettingsPath(orgId), label: "התראות חריגה", description: "ירידה בפניות, מי שלא עדכן רשומות, טופס שנעצר וקמפיין שהתייקר", icon: BellIcon }]
          : []),
        // CAL-10: each person their own pages; owners and admins all
        { href: bookingPagesPath(orgId), label: "דפי קביעת תור", description: "קישור שבו לקוחות קובעים פגישה בזמן פנוי", icon: CalendarIcon },
        // BIZ-02: each person their own card; owners and admins every card
        { href: businessCardSettingsPath(orgId), label: "כרטיס ביקור", description: "קישור וקוד QR לכרטיס דיגיטלי, עם טופס שנכנס כליד שלך", icon: UsersIcon },
        // BIZ-01: owners and admins only
        ...(access.admin
          ? [{ href: businessPageSettingsPath(orgId), label: "דף העסק", description: "דף ציבורי עם שעות פעילות, קביעת תור, WhatsApp וטופס פנייה", icon: BuildingIcon }]
          : []),
        // SPD-07: owners and admins only
        ...(access.admin
          ? [{ href: siteWidgetSettingsPath(orgId), label: "כפתור באתר", description: "כפתור צף לאתר שלכם: WhatsApp, חיוג וטופס קצר שנכנס כליד", icon: ChatIcon }]
          : []),
        // INT-01: owners and admins only
        ...(access.admin
          ? [{ href: integrationsSettingsPath(orgId), label: "אינטגרציות", description: "החיבורים למערכות אחרות, אם הם עובדים, ויומן מה קרה בהם", icon: BoltIcon }]
          : []),
        // CAP-11: owners and admins only
        ...(access.admin
          ? [{ href: metaLeadsSettingsPath(orgId), label: "לידים מפייסבוק ואינסטגרם", description: "חיבור דף עסקי: מי שממלא טופס במודעה נכנס כליד", icon: InboxIcon }]
          : []),
        // BIZ-03: owners and admins only
        ...(access.admin
          ? [{ href: qrCodesSettingsPath(orgId), label: "קודי QR", description: "קוד לכל שלט או פלייר, שפותח טופס או דף קביעת תור, עם ספירת סריקות", icon: FormIcon }]
          : []),
        // LEAD-05: everyone reads the rules; owners and admins change them
        { href: leadScoreSettingsPath(orgId), label: "ציון ליד", description: "כללים שמוסיפים או מורידים נקודות לליד", icon: ChartIcon },
      ],
    },
    {
      label: "נתונים",
      sections: [
        ...(access.canImport ? [{ href: paths.imports(orgId), label: "ייבוא וייצוא", description: "קובץ Excel או CSV פנימה, וגיבוי מלא החוצה", icon: UploadIcon }] : []),
        ...(access.canDelete ? [{ href: paths.settingsTrash(orgId), label: "סל מחזור", description: "שחזור רשומות שנמחקו ב-30 הימים האחרונים", icon: TrashIcon }] : []),
        ...(access.admin ? [{ href: paths.settingsAudit(orgId), label: "יומן ביקורת", description: "מי שינה מה ומתי", icon: LockIcon }] : []),
        // CNS-06: owners and admins only (addresses kept as a hash; the page searches one address)
        ...(access.admin
          ? [{ href: consentBlocklistPath(orgId), label: "רשימת חסימה לדיוור", description: "טלפונים ואימיילים שלעולם לא יקבלו דיוור", icon: LockIcon }]
          : []),
        // PRK-02: owners and admins only (privacy, every plan); before the privacy center, whose path is its prefix
        ...(access.admin
          ? [{ href: privacyRequestsPath(orgId), label: "בקשות פרטיות", description: "בקשות לעיון, תיקון ומחיקה של מידע, עם מועד יעד, והקישור לבקשות", icon: LockIcon }]
          : []),
        // PRK-01: owners and admins only (privacy, every plan)
        ...(access.admin
          ? [{ href: privacyCenterPath(orgId), label: "מרכז פרטיות", description: "איזה מידע אישי נשמר, מי מגיע אליו, קבלני משנה ומדיניות שמירה", icon: LockIcon }]
          : []),
        // PRV-01: owners and admins only (privacy, every plan)
        ...(access.admin
          ? [{ href: retentionSettingsPath(orgId), label: "מדיניות שמירה", description: "רשומות בלי קשר חודשים ארוכים עוברות לסל המחזור, עם רשימה מראש", icon: TrashIcon }]
          : []),
      ],
    },
  ];
  return groups.filter((group) => group.sections.length > 0);
}

/** The section a settings URL belongs to; "החשבון שלי" is not in the list but has a title. */
export function currentSection(pathname: string, groups: SettingsGroup[], accountHref: string): { href: string; label: string } | null {
  if (pathname === accountHref || pathname.startsWith(`${accountHref}/`)) {
    return { href: accountHref, label: "החשבון שלי" };
  }
  for (const group of groups) {
    for (const section of group.sections) {
      if (pathname === section.href || pathname.startsWith(`${section.href}/`)) return section;
    }
  }
  return null;
}
