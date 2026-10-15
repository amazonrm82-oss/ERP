import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEVICE_OFF_LINE, DEVICE_OFF_LINK, deviceNeedsWarning } from "@/features/notifications/device";

// GAP-01 follow-up (owner, 14 October 2026): the "this device will not get notifications" bar shows
// on the home screen and on the notifications page (where the device's push switch is) only, and the
// person can close it on this device.
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("device warning bar placement (GAP-01)", () => {
  const root = process.cwd();

  it("is rendered on the home screen and the notifications page, nowhere else", () => {
    const users = files(path.join(root, "src"))
      .filter((file) => /<DeviceWarning[\s/>]/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .sort();
    expect(users).toEqual(["src/app/o/[orgId]/notifications/page.tsx", "src/app/o/[orgId]/page.tsx"]);
  });

  it("can be closed, and the closing is kept on this device", () => {
    const source = readFileSync(path.join(root, "src/features/notifications/components/device-warning.tsx"), "utf8");
    expect(source).toContain('aria-label="סגירת ההודעה במכשיר הזה"');
    expect(source).toContain("window.localStorage.setItem(DISMISS_KEY, state)");
  });

  it("the account's notifications card has one line, only while the device does not get notifications (owner)", () => {
    // the exact wording, with the link text at its end
    expect(`${DEVICE_OFF_LINE} ${DEVICE_OFF_LINK}`).toBe("התראות למכשיר הזה כבויות. להפעלה: עמוד ההתראות");
    // the bar's own rule decides it
    expect(deviceNeedsWarning("ok")).toBe(false);
    expect(deviceNeedsWarning("unconfigured")).toBe(false);
    expect(deviceNeedsWarning("off")).toBe(true);

    const component = readFileSync(path.join(root, "src/features/notifications/components/device-warning.tsx"), "utf8");
    const line = component.slice(component.indexOf("export function DeviceOffLine"));
    expect(line).toContain("deviceNeedsWarning(state)");
    expect(line).toContain("paths.notifications(orgId)");
    // not a bar: no close button and nothing remembered
    expect(line).not.toContain("<button");
    expect(line).not.toContain("localStorage");

    const users = files(path.join(root, "src"))
      .filter((file) => /<DeviceOffLine[\s/>]/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file).split(path.sep).join("/"));
    expect(users).toEqual(["src/app/o/[orgId]/settings/account/page.tsx"]);
    const account = readFileSync(path.join(root, "src/app/o/[orgId]/settings/account/page.tsx"), "utf8");
    const card = account.slice(account.indexOf('aria-labelledby="account-notifications"'));
    expect(card.indexOf("<DeviceOffLine")).toBeGreaterThan(0);
    expect(card.indexOf("<DeviceOffLine")).toBeLessThan(card.indexOf("</Card>"));
  });
});
