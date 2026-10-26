// USR-08: iPhone launch screens (apple-touch-startup-image) for the installed app.
// The logo's "M" (public/icons/icon.svg, made by scripts/make-icons.mjs) centered on the light canvas of the
// design system (--mx-canvas, the manifest's background_color), one PNG per screen size and orientation in public/startup/
// (landscape = the portrait size turned on its side; iPhones only, no iPad sizes).
// The sizes mirror STARTUP_SCREENS in src/lib/startup-images.ts (a unit test compares them).
// Run after the logo changes: node scripts/make-startup-images.mjs
import { mkdir, readFile, rm } from "node:fs/promises";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const path = (p) => new URL(p, root).pathname;

const CANVAS = "#f4f6f8";
// [width, height, pixel ratio] in CSS points, portrait
const SCREENS = [
  [440, 956, 3],
  [402, 874, 3],
  [430, 932, 3],
  [393, 852, 3],
  [428, 926, 3],
  [390, 844, 3],
  [375, 812, 3],
  [414, 896, 2],
  [375, 667, 2],
];
// the mark is 96 points wide on every phone, a little under the size of a home screen icon's mark seen up close
const MARK_POINTS = 96;

const svg = await readFile(path("public/icons/icon.svg"));
await rm(path("public/startup"), { recursive: true, force: true });
await mkdir(path("public/startup"), { recursive: true });

// portrait first, then the same screens turned on their side
const IMAGES = [
  ...SCREENS.map(([w, h, ratio]) => [w * ratio, h * ratio, ratio]),
  ...SCREENS.map(([w, h, ratio]) => [h * ratio, w * ratio, ratio]),
];

let total = 0;
for (const [width, height, ratio] of IMAGES) {
  const markSize = MARK_POINTS * ratio;
  // icon.svg is 64 units wide; render it at the mark's pixel size
  const mark = await sharp(svg, { density: (72 * markSize) / 64 })
    .resize(markSize, markSize)
    .png()
    .toBuffer();
  const file = path(`public/startup/iphone-${width}x${height}.png`);
  const info = await sharp({ create: { width, height, channels: 3, background: CANVAS } })
    .composite([{ input: mark, left: Math.round((width - markSize) / 2), top: Math.round((height - markSize) / 2) }])
    .png({ compressionLevel: 9, palette: true, colours: 64 })
    .toFile(file);
  total += info.size;
  console.log(`${file.split("/").slice(-2).join("/")}  ${info.size} bytes`);
}
console.log(`${IMAGES.length} launch screens, ${total} bytes`);
