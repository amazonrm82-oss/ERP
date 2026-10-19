import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  applyThemeChoice,
  choiceFromProfile,
  cspNonce,
  isAlwaysLightPath,
  pageThemeChoice,
  PATH_HEADER,
  parseThemeChoice,
  profileFromChoice,
  serverThemeAttribute,
  THEME_COOKIE,
  THEME_SCRIPT,
  themeCookieLine,
} from "@/features/theme/theme";

// USR-07 (owner, 18 October 2026): by the device by default, or light / dark from the profile.

class FakeRoot {
  attrs = new Map<string, string>();
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
}

/** Runs the head script on a fake page; returns the root and a way to flip the device's preference. */
function runScript(choice: string | null, prefersDark: boolean) {
  const root = new FakeRoot();
  if (choice) root.setAttribute("data-theme-choice", choice);
  if (choice === "light" || choice === "dark") root.setAttribute("data-theme", choice);
  const listeners: Array<() => void> = [];
  const media = { matches: prefersDark, addEventListener: (_: string, fn: () => void) => listeners.push(fn) };
  vm.runInNewContext(THEME_SCRIPT, { document: { documentElement: root }, window: { matchMedia: () => media } });
  return {
    root,
    flip(dark: boolean) {
      media.matches = dark;
      for (const fn of listeners) fn();
    },
  };
}

describe("theme choice (USR-07)", () => {
  it("reads the cookie and the profile; anything unknown is by the device", () => {
    expect(parseThemeChoice("dark")).toBe("dark");
    expect(parseThemeChoice("light")).toBe("light");
    expect(parseThemeChoice(undefined)).toBe("system");
    expect(parseThemeChoice("purple")).toBe("system");
    expect(choiceFromProfile(null)).toBe("system");
    expect(choiceFromProfile("dark")).toBe("dark");
    expect(profileFromChoice("system")).toBeNull();
    expect(profileFromChoice("light")).toBe("light");
    expect(serverThemeAttribute("system")).toBeUndefined();
    expect(serverThemeAttribute("dark")).toBe("dark");
    expect(themeCookieLine("dark")).toBe(`${THEME_COOKIE}=dark; path=/; max-age=31536000; samesite=lax`);
  });

  it("the head script follows the device while nothing is picked, now and when the device changes", () => {
    const dark = runScript("system", true);
    expect(dark.root.getAttribute("data-theme")).toBe("dark");
    dark.flip(false);
    expect(dark.root.getAttribute("data-theme")).toBeNull();
    dark.flip(true);
    expect(dark.root.getAttribute("data-theme")).toBe("dark");

    const light = runScript("system", false);
    expect(light.root.getAttribute("data-theme")).toBeNull();
  });

  it("the head script leaves a picked theme alone, whatever the device says", () => {
    const picked = runScript("light", true);
    expect(picked.root.getAttribute("data-theme")).toBe("light");
    picked.flip(true);
    expect(picked.root.getAttribute("data-theme")).toBe("light");
    expect(runScript("dark", false).root.getAttribute("data-theme")).toBe("dark");
  });

  it("applying a choice on the page follows the same rule", () => {
    const root = new FakeRoot();
    applyThemeChoice("dark", root, false);
    expect([root.getAttribute("data-theme-choice"), root.getAttribute("data-theme")]).toEqual(["dark", "dark"]);
    applyThemeChoice("system", root, false);
    expect([root.getAttribute("data-theme-choice"), root.getAttribute("data-theme")]).toEqual(["system", null]);
    applyThemeChoice("system", root, true);
    expect(root.getAttribute("data-theme")).toBe("dark");
    applyThemeChoice("light", root, true);
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("the script carries the page's CSP nonce", () => {
    expect(cspNonce("default-src 'self'; script-src 'self' 'nonce-AbC+/9=' 'strict-dynamic'")).toBe("AbC+/9=");
    expect(cspNonce(null)).toBeUndefined();
  });

  it("customer-facing pages stay light whatever the cookie or the device says (until the owner decides)", () => {
    for (const path of ["/", "/f", "/f/abc", "/f/book/abc", "/f/quote/abc", "/f/widget/abc", "/f/card/abc", "/f/embed/abc"]) {
      expect(isAlwaysLightPath(path), path).toBe(true);
      expect(pageThemeChoice(path, "dark"), path).toBe("light");
      expect(pageThemeChoice(path, undefined), path).toBe("light");
    }
    for (const path of ["/app", "/o/1/leads", "/login", "/fx", "/admin/design"]) {
      expect(isAlwaysLightPath(path), path).toBe(false);
    }
    expect(pageThemeChoice("/o/1", "dark")).toBe("dark");
    expect(pageThemeChoice("/o/1", undefined)).toBe("system");
    // a pinned light page is left alone by the head script, even on a dark device
    expect(runScript(pageThemeChoice("/f/abc", undefined), true).root.getAttribute("data-theme")).toBe("light");
  });

  it("the proxy sets the path header itself (a visitor's own header never counts), and the layout reads it", () => {
    const proxy = readFileSync(new URL("../../src/lib/supabase/proxy.ts", import.meta.url), "utf8");
    expect(proxy).toMatch(/headers\.set\(PATH_HEADER, request\.nextUrl\.pathname\)/);
    expect(PATH_HEADER).toBe("x-crm-path");
    const layout = readFileSync(new URL("../../src/app/layout.tsx", import.meta.url), "utf8");
    expect(layout).toMatch(/pageThemeChoice\(headerStore\.get\(PATH_HEADER\), cookieStore\.get\(THEME_COOKIE\)\?\.value\)/);
  });

  it("the business shell's theme read never throws: a failed read is by the device", () => {
    const shell = readFileSync(new URL("../../src/app/o/[orgId]/layout.tsx", import.meta.url), "utf8");
    const fn = shell.slice(shell.indexOf("async function profileThemeForNewDevice"));
    expect(fn).not.toMatch(/must\(/);
    expect(fn).toMatch(/return error \? "system"/);
    expect(fn).toMatch(/catch \{\s*return "system";/);
  });

  it("the root layout renders the pick on <html> and the script in <head>", () => {
    const layout = readFileSync(new URL("../../src/app/layout.tsx", import.meta.url), "utf8");
    expect(layout).toMatch(/data-theme=\{serverThemeAttribute\(themeChoice\)\}/);
    expect(layout).toMatch(/<script nonce=\{nonce\} dangerouslySetInnerHTML=\{\{ __html: THEME_SCRIPT \}\} \/>/);
  });
});
