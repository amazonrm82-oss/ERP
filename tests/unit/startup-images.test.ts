import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { STARTUP_ORIENTATIONS, STARTUP_SCREENS, startupImages, startupImageSize, startupImageUrl } from "@/lib/startup-images";

// USR-08: iOS shows a launch image only when its pixel size equals the screen's, so every listed screen
// needs its file at exactly that size, and the generating script must make the same list.
const dir = join(process.cwd(), "public/startup");

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("iPhone launch screens", () => {
  it("has one file per screen and orientation, at the screen's pixel size, and nothing else", () => {
    const expected = STARTUP_ORIENTATIONS.flatMap((o) => STARTUP_SCREENS.map((s) => startupImageUrl(s, o).replace("/startup/", "")));
    expect(new Set(expected).size).toBe(STARTUP_SCREENS.length * 2);
    expect(readdirSync(dir).sort()).toEqual([...expected].sort());
    for (const screen of STARTUP_SCREENS) {
      const portrait = pngSize(join(process.cwd(), "public", startupImageUrl(screen, "portrait")));
      expect(portrait).toEqual({ width: screen.width * screen.ratio, height: screen.height * screen.ratio });
      // landscape: the same screen turned on its side
      const landscape = pngSize(join(process.cwd(), "public", startupImageUrl(screen, "landscape")));
      expect(landscape).toEqual({ width: screen.height * screen.ratio, height: screen.width * screen.ratio });
      expect(startupImageSize(screen, "landscape")).toEqual(landscape);
    }
  });

  it("matches the script's list", () => {
    const script = readFileSync(join(process.cwd(), "scripts/make-startup-images.mjs"), "utf8");
    const listed = [...script.matchAll(/\[(\d+), (\d+), ([23])\]/g)].map((m) => ({ width: Number(m[1]), height: Number(m[2]), ratio: Number(m[3]) }));
    expect(listed).toEqual(STARTUP_SCREENS);
  });

  it("gives each image a media query of its own screen and orientation", () => {
    const images = startupImages();
    expect(images).toHaveLength(STARTUP_SCREENS.length * 2);
    expect(new Set(images.map((i) => i.media)).size).toBe(images.length);
    expect(new Set(images.map((i) => i.url)).size).toBe(images.length);
    expect(images[0]).toEqual({
      url: "/startup/iphone-1320x2868.png",
      media: "(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)",
    });
    // iOS keeps the portrait device-width and device-height in landscape; only the orientation and the image change
    expect(images[STARTUP_SCREENS.length]).toEqual({
      url: "/startup/iphone-2868x1320.png",
      media: "(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)",
    });
  });

  it("keeps the launch screens small", () => {
    const total = readdirSync(dir).reduce((sum, name) => sum + readFileSync(join(dir, name)).length, 0);
    expect(total).toBeLessThan(150_000);
  });
});
