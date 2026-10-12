import type { ComponentType, SVGProps } from "react";

import {
  BoardIcon,
  BoltIcon,
  ChartIcon,
  BuildingIcon,
  FormIcon,
  InboxIcon,
  LockIcon,
  PencilIcon,
  TagIcon,
  TrashIcon,
  UploadIcon,
  UsersIcon,
} from "@/components/ui/icons";
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
  // owners, admins and team managers who can write (app.can_import)
  canImport: boolean;
  // owners, admins and team managers (recycle bin)
  canDelete: boolean;
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
        ...(access.admin
          ? [{ href: paths.settingsPlan(orgId), label: "חבילה ושימוש", description: "החבילה, ימי הניסיון והשימוש מול כל מכסה", icon: ChartIcon }]
          : []),
      ],
    },
    {
      label: "התאמה אישית",
      sections: access.admin
        ? [
            { href: paths.settingsPipelines(orgId), label: "פייפליינים", description: "שלבי המכירה של העסקאות", icon: BoardIcon },
            { href: paths.settingsLeads(orgId), label: "סטטוסים ומקורות", description: "השלבים של ליד ומאיפה הוא הגיע", icon: InboxIcon },
            { href: paths.settingsDisqualifyReasons(orgId), label: "סיבות לליד לא רלוונטי", description: "הרשימה שבוחרים ממנה כשליד לא רלוונטי", icon: InboxIcon },
            { href: paths.settingsFields(orgId), label: "שדות", description: "שדות משלכם בכרטיסים ובטפסים", icon: PencilIcon },
            { href: paths.settingsTags(orgId), label: "תגיות", description: "סימון רשומות וסינון לפיהן", icon: TagIcon },
          ]
        : [],
    },
    {
      label: "לידים ואוטומציות",
      sections: access.admin
        ? [
            { href: paths.settingsIntake(orgId), label: "טפסים וחיבורים", description: "טפסים, קישור לשיתוף וחלוקת לידים", icon: FormIcon },
            { href: paths.settingsAutomations(orgId), label: "אוטומציות", description: "פעולות שקורות לבד, בלי לזכור", icon: BoltIcon },
          ]
        : [],
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
