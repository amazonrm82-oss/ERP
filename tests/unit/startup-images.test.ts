import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { STARTUP_SCREENS, startupImages, startupImageUrl } from "@/lib/startup-images";

// USR-08: iOS shows a launch image only when its pixel size equals the screen's, so every listed screen
// needs its file at exactly that size, and the generating script must make the same list.
const dir = join(process.cwd(), "public/startup");

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("iPhone launch screens", () => {
  it("has one file per screen, at the screen's pixel size, and nothing else", () => {
    const expected = STARTUP_SCREENS.map((s) => startupImageUrl(s).replace("/startup/", ""));
    expect(readdirSync(dir).sort()).toEqual([...expected].sort());
    for (const screen of STARTUP_SCREENS) {
      const size = pngSize(join(process.cwd(), "public", startupImageUrl(screen)));
      expect(size).toEqual({ width: screen.width * screen.ratio, height: screen.height * screen.ratio });
    }
  });

  it("matches the script's list", () => {
    const script = readFileSync(join(process.cwd(), "scripts/make-startup-images.mjs"), "utf8");
    const listed = [...script.matchAll(/\[(\d+), (\d+), ([23])\]/g)].map((m) => ({ width: Number(m[1]), height: Number(m[2]), ratio: Number(m[3]) }));
    expect(listed).toEqual(STARTUP_SCREENS);
  });

  it("gives each image a portrait media query of its own screen", () => {
    const images = startupImages();
    expect(new Set(images.map((i) => i.media)).size).toBe(images.length);
    expect(images[0].media).toBe(
      "(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)",
    );
  });

  it("keeps the launch screens small", () => {
    const total = readdirSync(dir).reduce((sum, name) => sum + readFileSync(join(dir, name)).length, 0);
    expect(total).toBeLessThan(150_000);
  });
});
