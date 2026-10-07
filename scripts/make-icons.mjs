// Draws the app icons (the wordmark's mark: a white ring on the accent color) into public/icons.
// Run after changing the mark or the color: node scripts/make-icons.mjs
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

const ACCENT = "#0f6b6b";
const out = new URL("../public/icons/", import.meta.url);

// rounded: a rounded square on transparent (regular icons);
// full: the color fills the square and the ring stays inside the maskable safe zone.
function svg(size, { rounded }) {
  const ring = size * (rounded ? 0.2 : 0.16);
  const stroke = size * (rounded ? 0.075 : 0.06);
  const bg = rounded
    ? `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${ACCENT}"/>`
    : `<rect width="${size}" height="${size}" fill="${ACCENT}"/>`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${ring}" fill="none" stroke="#fff" stroke-width="${stroke}"/></svg>`,
  );
}

await mkdir(out, { recursive: true });
const jobs = [
  ["icon-192.png", 192, { rounded: true }],
  ["icon-512.png", 512, { rounded: true }],
  ["maskable-512.png", 512, { rounded: false }],
  ["apple-touch-icon.png", 180, { rounded: false }], // iOS rounds the corners itself
  ["favicon-32.png", 32, { rounded: true }],
];
for (const [name, size, opts] of jobs) {
  await sharp(svg(size, opts)).png().toFile(new URL(name, out).pathname);
}
await import("node:fs/promises").then((fs) => fs.writeFile(new URL("icon.svg", out), svg(64, { rounded: true })));
console.log("icons written");
