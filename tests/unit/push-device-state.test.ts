import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEVICE_FIX, deviceNeedsWarning, deviceState, isIosDevice, type DeviceCapabilities } from "@/features/notifications/device";
import { parseTestSendResult, TEST_PER_WINDOW, TEST_WINDOW_MINUTES, testRateMessage } from "@/features/notifications/test-send";

// a desktop Chrome that is subscribed: everything works
const ready: DeviceCapabilities = {
  configured: true,
  hasNotification: true,
  hasServiceWorker: true,
  hasPushManager: true,
  permission: "granted",
  subscribed: true,
  ios: false,
  standalone: false,
};

describe("device push state (GAP-01)", () => {
  it("is ok when the browser can push and holds a subscription", () => {
    expect(deviceState(ready)).toBe("ok");
    // a subscription that could not be checked is not a reason to warn
    expect(deviceState({ ...ready, subscribed: null })).toBe("ok");
    expect(deviceNeedsWarning("ok")).toBe(false);
  });

  it("says nothing when push is not set up on the site", () => {
    expect(deviceState({ ...ready, configured: false, permission: "denied", subscribed: false })).toBe("unconfigured");
    expect(deviceNeedsWarning("unconfigured")).toBe(false);
  });

  it("tells an iPhone in Safari to add the app to the home screen first", () => {
    const safariTab = { ...ready, ios: true, standalone: false, hasPushManager: false, hasNotification: false, permission: null, subscribed: null };
    expect(deviceState(safariTab)).toBe("ios_install");
    expect(DEVICE_FIX.ios_install).toContain("הוסף למסך הבית");
    // installed on the home screen, it is judged like any browser
    expect(deviceState({ ...ready, ios: true, standalone: true })).toBe("ok");
    expect(deviceState({ ...ready, ios: true, standalone: true, permission: "default", subscribed: false })).toBe("off");
  });

  it("flags a browser with no Notification, service worker or Push API", () => {
    expect(deviceState({ ...ready, hasNotification: false, permission: null })).toBe("unsupported");
    expect(deviceState({ ...ready, hasServiceWorker: false })).toBe("unsupported");
    expect(deviceState({ ...ready, hasPushManager: false, subscribed: null })).toBe("unsupported");
  });

  it("flags blocked permission before a missing subscription", () => {
    expect(deviceState({ ...ready, permission: "denied", subscribed: false })).toBe("denied");
  });

  it("flags a device that never turned push on, or lost its subscription", () => {
    expect(deviceState({ ...ready, permission: "default", subscribed: false })).toBe("off");
    expect(deviceState({ ...ready, permission: "default", subscribed: null })).toBe("off");
    expect(deviceState({ ...ready, subscribed: false })).toBe("off");
  });

  it("warns, with a how-to-fix text, for every state the user can fix", () => {
    for (const state of ["ios_install", "unsupported", "denied", "off"] as const) {
      expect(deviceNeedsWarning(state)).toBe(true);
      expect(DEVICE_FIX[state].length).toBeGreaterThan(20);
    }
  });

  it("recognizes iPhone and iPad, including iPadOS that reports a Mac", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
    const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
    expect(isIosDevice(iphone, "iPhone", 5)).toBe(true);
    expect(isIosDevice(mac, "MacIntel", 5)).toBe(true);
    expect(isIosDevice(mac, "MacIntel", 0)).toBe(false);
    expect(isIosDevice(android, "Linux armv8l", 5)).toBe(false);
  });
});

describe("test notification answers (GAP-01)", () => {
  it("reads the database answer and refuses anything else", () => {
    expect(parseTestSendResult({ ok: true })).toEqual({ ok: true });
    expect(parseTestSendResult({ ok: false, reason: "rate", retry_seconds: 61 })).toEqual({ ok: false, reason: "rate", retry_seconds: 61 });
    expect(parseTestSendResult({ ok: false })).toBeNull();
    expect(parseTestSendResult(null)).toBeNull();
  });

  it("rounds the wait up to whole minutes", () => {
    expect(testRateMessage(30)).toContain("בעוד דקה");
    expect(testRateMessage(61)).toContain("בעוד 2 דקות");
    expect(testRateMessage(600)).toContain("בעוד 10 דקות");
  });

  it("states the same limit as the migration", () => {
    // found by name, so renumbering the migration keeps the test working
    const file = readdirSync("supabase/migrations").find((name) => name.endsWith("_push_test.sql"));
    expect(file).toBeDefined();
    const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
    expect(sql).toContain(`window_count >= ${TEST_PER_WINDOW}`);
    expect(sql).toContain(`interval '${TEST_WINDOW_MINUTES} minutes'`);
  });
});
