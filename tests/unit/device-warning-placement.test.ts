import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
});
