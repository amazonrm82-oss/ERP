import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { notificationHref } from "@/features/notifications/links";
import { NOTIFICATION_KINDS, shownNotificationGroups } from "@/features/notifications/settings";

// USR-06: the app's list of notification kinds and the database's check
// constraints must be the same list.
const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");

/** The kinds in the last migration that sets the given constraint. */
function kindsInLastMigration(constraint: string): string[] {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files.reverse()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    const at = sql.indexOf(`add constraint ${constraint} check`);
    if (at >= 0) {
      const body = sql.slice(at, sql.indexOf(";", at));
      // notification_settings lists the kinds twice (muted, no_push): take the first list
      const list = body.slice(body.indexOf("("), body.indexOf("]") >= 0 ? body.indexOf("]") : undefined);
      return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    }
  }
  throw new Error(`no migration sets ${constraint}`);
}

describe("notification kinds (USR-06)", () => {
  const keys = NOTIFICATION_KINDS.map((k) => k.key as string);

  it("every key is unique, and 'system' cannot be chosen", () => {
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("system");
  });

  it("matches the database: settings accept exactly these kinds, notifications these plus 'system'", () => {
    expect(kindsInLastMigration("notification_settings_kinds").sort()).toEqual([...keys].sort());
    expect(kindsInLastMigration("notifications_kinds").sort()).toEqual([...keys, "system"].sort());
  });

  it("the settings screen shows the kinds that are built, in groups, and no empty group", () => {
    const groups = shownNotificationGroups();
    const shown = groups.flatMap((g) => g.kinds.map((k) => k.key as string));
    expect(shown).toEqual(expect.arrayContaining(["assigned", "lead_new", "mention", "follow", "meeting_scheduled", "meeting_reminder", "automation_failed"]));
    expect(shown).not.toContain("payment");
    expect(groups.every((g) => g.kinds.length > 0)).toBe(true);
    // the labels are what the screen and the e2e find the fields by
    const labels = NOTIFICATION_KINDS.map((k) => k.label as string);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("a notification about a meeting or an automation leads to its page", () => {
    const org = "00000000-0000-4000-8000-000000000001";
    const id = "00000000-0000-4000-8000-000000000002";
    expect(notificationHref(org, "meeting", id)).toBe(`/o/${org}/calendar?view=agenda`);
    expect(notificationHref(org, "automation", id)).toBe(`/o/${org}/settings/automations/${id}`);
    // TAX-02 follow-up: a bank details change leads to the documents settings
    expect(notificationHref(org, "org_bank_details", id)).toBe(`/o/${org}/settings/documents`);
    expect(notificationHref(org, "lead", id)).toBe(`/o/${org}/leads/${id}`);
    // QUO-09: an accepted or declined quote leads to the quote
    expect(notificationHref(org, "quote", id)).toBe(`/o/${org}/quotes/${id}`);
    expect(notificationHref(org, "something", id)).toBeNull();
    expect(notificationHref(org, "meeting", null)).toBeNull();
  });
});
