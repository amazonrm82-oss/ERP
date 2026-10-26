// USR-08: the launch screen an iPhone shows while the installed app opens (apple-touch-startup-image).
// iOS uses an image only when its pixel size matches the screen exactly, so there is one per screen size.
// The images are made by scripts/make-startup-images.mjs, which keeps its own copy of this list
// (tests/unit/startup-images.test.ts checks that both lists and the files agree).
// Portrait and landscape (owner, 26 October 2026: iPhones only, no iPad sizes). In landscape iOS still matches
// device-width and device-height against the portrait points, so only the orientation and the image differ.
// A phone that matches no entry shows the plain background, as before.

export type StartupScreen = { width: number; height: number; ratio: 2 | 3 };
export type StartupOrientation = "portrait" | "landscape";

export const STARTUP_ORIENTATIONS: readonly StartupOrientation[] = ["portrait", "landscape"];

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

/** The image's pixel size: the screen's, turned on its side in landscape. */
export function startupImageSize({ width, height, ratio }: StartupScreen, orientation: StartupOrientation = "portrait"): { width: number; height: number } {
  return orientation === "portrait" ? { width: width * ratio, height: height * ratio } : { width: height * ratio, height: width * ratio };
}

export function startupImageUrl(screen: StartupScreen, orientation: StartupOrientation = "portrait"): string {
  const { width, height } = startupImageSize(screen, orientation);
  return `/startup/iphone-${width}x${height}.png`;
}

/** The entries for Next's `appleWebApp.startupImage`: one link per screen and orientation, matched by its media query. */
export function startupImages(): { url: string; media: string }[] {
  return STARTUP_ORIENTATIONS.flatMap((orientation) =>
    STARTUP_SCREENS.map((screen) => ({
      url: startupImageUrl(screen, orientation),
      media: `(device-width: ${screen.width}px) and (device-height: ${screen.height}px) and (-webkit-device-pixel-ratio: ${screen.ratio}) and (orientation: ${orientation})`,
    })),
  );
}
