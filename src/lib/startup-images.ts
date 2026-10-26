// USR-08: the launch screen an iPhone shows while the installed app opens (apple-touch-startup-image).
// iOS uses an image only when its pixel size matches the screen exactly, so there is one per screen size.
// The images are made by scripts/make-startup-images.mjs, which keeps its own copy of this list
// (tests/unit/startup-images.test.ts checks that both lists and the files agree).
// Portrait only; a phone that matches no entry shows the plain background, as before.

export type StartupScreen = { width: number; height: number; ratio: 2 | 3 };

/** CSS points and pixel ratio of the common iPhone screens, newest first. */
export const STARTUP_SCREENS: readonly StartupScreen[] = [
  { width: 440, height: 956, ratio: 3 }, // 16 Pro Max
  { width: 402, height: 874, ratio: 3 }, // 16 Pro
  { width: 430, height: 932, ratio: 3 }, // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  { width: 393, height: 852, ratio: 3 }, // 14 Pro, 15, 15 Pro, 16
  { width: 428, height: 926, ratio: 3 }, // 12 Pro Max, 13 Pro Max, 14 Plus
  { width: 390, height: 844, ratio: 3 }, // 12, 13, 14, 12 Pro, 13 Pro
  { width: 375, height: 812, ratio: 3 }, // X, XS, 11 Pro, 12 mini, 13 mini
  { width: 414, height: 896, ratio: 2 }, // XR, 11
  { width: 375, height: 667, ratio: 2 }, // SE (2nd and 3rd), 8
];

export function startupImageUrl({ width, height, ratio }: StartupScreen): string {
  return `/startup/iphone-${width * ratio}x${height * ratio}.png`;
}

/** The entries for Next's `appleWebApp.startupImage`: one link per screen, matched by its media query. */
export function startupImages(): { url: string; media: string }[] {
  return STARTUP_SCREENS.map((screen) => ({
    url: startupImageUrl(screen),
    media: `(device-width: ${screen.width}px) and (device-height: ${screen.height}px) and (-webkit-device-pixel-ratio: ${screen.ratio}) and (orientation: portrait)`,
  }));
}
