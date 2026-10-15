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
import { calendarSettingsPath } from "@/features/calendar-days/paths";
import { cardLayoutSettingsPath } from "@/features/card-layout/paths";
import { conversionMapSettingsPath } from "@/features/conversion-map/paths";
import { leadScoreSettingsPath } from "@/features/lead-score/paths";
import { meetingTypesPath } from "@/features/meeting-types/paths";
import { priceListsPath } from "@/features/price-lists/paths";
import { productListsSettingsPath } from "@/features/products/paths";
import { completenessSettingsPath } from "@/features/data-quality/paths";
import { documentSettingsPath } from "@/features/tax/paths";
import { numberingSettingsPath } from "@/features/numbering/paths";
import { responseSettingsPath } from "@/features/response-target/paths";
import { distributionSettingsPath } from "@/features/lead-distribution/paths";
import { whatsappTemplatesPath } from "@/features/whatsapp/paths";
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
  // and the owner in every state for the full export (BIL-09)
  canImport: boolean;
  // owners, admins and team managers (recycle bin)
  canDelete: boolean;
  // PL-01: the plan holds the 'price_lists' capability (orgHasFeature); without it the section is hidden
  priceLists?: boolean;
};

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
        // QUO-03: everyone reads it; owners and admins change it
        { href: numberingSettingsPath(orgId), label: "מספור הצעות והזמנות", description: "קידומת ומספר התחלתי למספרים של הצעות מחיר והזמנות", icon: FormIcon },
        // PL-01: everyone reads the price lists; owners and admins edit them. Hidden without the capability.
        ...(access.priceLists
          ? [{ href: priceListsPath(orgId), label: "מחירונים", description: "מחירים אחרים או הנחות לחלק מהמוצרים, לתקופה מסוימת", icon: TagIcon }]
          : []),
        ...(access.admin
          ? [
              { href: paths.settingsPlan(orgId), label: "חבילה ושימוש", description: "החבילה, ימי הניסיון והשימוש מול כל מכסה", icon: ChartIcon },
              { href: paths.settingsSetupChecklist(orgId), label: "רשימת הקמה", description: "מה כבר מוכן בעסק, ונתוני דוגמה", icon: CheckSquareIcon },
            ]
          : []),
      ],
    },
    {
      label: "התאמה אישית",
      sections: access.admin
        ? [
            { href: paths.settingsPipelines(orgId), label: "פייפליינים", description: "שלבי המכירה של העסקאות", icon: BoardIcon },
            { href: paths.settingsDealLossReasons(orgId), label: "סיבות הפסד", description: "הרשימה שבוחרים ממנה כשעסקה אבודה", icon: BoardIcon },
            // PRD-04
            { href: productListsSettingsPath(orgId), label: "קטגוריות ויחידות מידה", description: "הרשימות שבוחרים מהן בכל מוצר בקטלוג", icon: TagIcon },
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
          ]
        : [],
    },
    {
      label: "לידים ואוטומציות",
      sections: [
        ...(access.admin
          ? [
              { href: paths.settingsIntake(orgId), label: "טפסים וחיבורים", description: "טפסים, קישור לשיתוף וחלוקת לידים", icon: FormIcon },
              { href: paths.settingsAutomations(orgId), label: "אוטומציות", description: "פעולות שקורות לבד, בלי לזכור", icon: BoltIcon },
            ]
          : []),
        // CAP-08: everyone reads it; owners and admins change it
        { href: distributionSettingsPath(orgId), label: "חלוקת לידים", description: "סבב, משקל, עומס פתוח, וכללים לפי מקור ומוצר", icon: UsersIcon },
        // CAP-10: everyone reads it; owners and admins change it
        { href: responseSettingsPath(orgId), label: "יעד זמן תגובה", description: "תוך כמה זמן עונים לליד חדש, ומה קורה כשלא", icon: BellIcon },
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
