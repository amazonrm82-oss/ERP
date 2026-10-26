// REC-09: the command palette. Besides records, the global search offers actions ("ליד חדש") and places to go
// ("הגדרות", "יומן", a settings section) that match the typed text. The list is built on the server from the same
// sources as the menu, the "+" menu and the settings list, so it never offers what the person cannot see there:
// roles and extra permissions, modules switched off (LEAD-08), the plan (orders, price lists) and the business's own
// words (FLD-10). Opening a command only navigates; every screen still checks its own rights.

import type { OrgModules } from "@/features/modules/modules";
import { settingsGroups, type SettingsAccess } from "@/features/settings/sections";
import { createItems, navItems } from "@/features/shell/nav";
import { DEFAULT_TERMS, type OrgTerms } from "@/features/terminology/terms";
import { paths } from "@/lib/paths";

import type { Command } from "./command-match";

export type { Command, CommandGroup } from "./command-match";

export type CommandAccess = {
  /** may create records (the "+" menu): not a viewer, not a read-only business */
  canWrite: boolean;
  settings: SettingsAccess;
};

const CREATE_WORDS = ["חדש", "חדשה", "יצירה", "ליצור", "הוספה", "להוסיף", "new"];
const NAVIGATE_WORDS = ["מעבר", "פתיחה", "מסך"];

/** Today's words for a record type, so "ליד חדש" still finds "פנייה חדשה" in a business that renamed it. */
function defaultWords(key: string, kind: "singular" | "plural"): string[] {
  if (key === "lead" || key === "leads") return [DEFAULT_TERMS.lead[kind]];
  if (key === "contact" || key === "contacts") return [DEFAULT_TERMS.contact[kind]];
  if (key === "deal" || key === "deals") return [DEFAULT_TERMS.deal[kind]];
  return [];
}

export function buildCommands(orgId: string, terms: OrgTerms, modules: OrgModules, access: CommandAccess): Command[] {
  const commands: Command[] = [];
  if (access.canWrite) {
    for (const item of createItems(orgId, terms, modules)) {
      commands.push({
        key: `create:${item.key}`,
        group: "create",
        label: item.label,
        hint: null,
        href: item.href,
        keywords: [...CREATE_WORDS, ...defaultWords(item.key, "singular"), item.key],
      });
    }
  }
  for (const item of navItems(orgId, terms, modules)) {
    commands.push({
      key: `nav:${item.key}`,
      group: "navigate",
      label: item.label,
      hint: null,
      href: item.href,
      keywords: [...NAVIGATE_WORDS, ...defaultWords(item.key, "plural"), item.key],
    });
  }
  // the places of the user menu and the phone's "עוד" sheet
  commands.push(
    { key: "nav:notifications", group: "navigate", label: "התראות", hint: null, href: paths.notifications(orgId), keywords: [...NAVIGATE_WORDS, "notifications"] },
    { key: "nav:help", group: "navigate", label: "מרכז עזרה", hint: null, href: paths.help, keywords: [...NAVIGATE_WORDS, "עזרה", "help"] },
    { key: "nav:switch", group: "navigate", label: "החלפת עסק", hint: null, href: paths.home, keywords: [...NAVIGATE_WORDS, "עסקים"] },
  );
  commands.push({
    key: "settings:account",
    group: "settings",
    label: "החשבון שלי",
    hint: "סיסמה, אימות דו-שלבי, התראות ומכשירים מחוברים",
    href: paths.settingsAccount(orgId),
    keywords: ["הגדרות", "settings"],
  });
  for (const group of settingsGroups(orgId, access.settings)) {
    for (const section of group.sections) {
      commands.push({
        key: `settings:${section.href}`,
        group: "settings",
        label: section.label,
        hint: section.description,
        href: section.href,
        keywords: ["הגדרות", "settings", group.label],
      });
    }
  }
  return commands;
}
