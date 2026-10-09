// Brand assets from the owner's logo (docs/brand/mexuz-logo-original.png):
// - src/assets/mexuz-logo.png: the wordmark, trimmed, for the app header
// - public/icons/*: app icons with the logo's "M", redrawn as vector so it stays sharp
// - src/app/opengraph-image.png: the picture beside a shared link (WhatsApp, Google), 1200 x 630 (DSN-15)
// Run after the logo changes: node scripts/make-icons.mjs
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const path = (p) => new URL(p, root).pathname;

// The "M": two navy legs under a blue-to-violet chevron, as in the logo.
// Drawn in a 306 x 232 box.
const M_BODY = `
  <defs>
    <linearGradient id="l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1479f7"/><stop offset="1" stop-color="#39abfc"/></linearGradient>
    <linearGradient id="r" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#3359fb"/><stop offset="1" stop-color="#7c49f8"/></linearGradient>
  </defs>
  <rect x="0" y="50" width="60" height="182" rx="4" fill="#0e1c36"/>
  <rect x="246" y="50" width="60" height="182" rx="4" fill="#0e1c36"/>
  <path d="M0 6 Q0 -4 12 2 L153 86 L153 160 Q146 162 138 156 L0 60 Z" fill="url(#l)"/>
  <path d="M306 6 Q306 -4 294 2 L153 86 L153 160 Q160 162 168 156 L306 60 Z" fill="url(#r)"/>`;

/** The mark on white, `scale` of the icon's width, centered. */
function icon(size, { rounded, scale }) {
  const w = size * scale;
  const k = w / 306;
  const h = 232 * k;
  const bg = rounded ? `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="#fff"/>` : `<rect width="${size}" height="${size}" fill="#fff"/>`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}` +
      `<g transform="translate(${(size - w) / 2} ${(size - h) / 2}) scale(${k})">${M_BODY}</g></svg>`,
  );
}

await mkdir(path("public/icons"), { recursive: true });
await mkdir(path("src/assets"), { recursive: true });
const jobs = [
  ["icon-192.png", 192, { rounded: true, scale: 0.62 }],
  ["icon-512.png", 512, { rounded: true, scale: 0.62 }],
  // maskable: the launcher may crop to a circle, so the mark stays inside the middle 80%
  ["maskable-512.png", 512, { rounded: false, scale: 0.5 }],
  ["apple-touch-icon.png", 180, { rounded: false, scale: 0.62 }], // iOS rounds the corners itself
  ["favicon-32.png", 32, { rounded: false, scale: 0.86 }],
];
for (const [name, size, opts] of jobs) {
  await sharp(icon(size, opts)).png().toFile(path(`public/icons/${name}`));
}
await writeFile(path("public/icons/icon.svg"), icon(64, { rounded: false, scale: 0.86 }).toString().replace(/<rect width="64" height="64" fill="#fff"\/>/, ""));

// the wordmark for the header: trimmed, 160px tall (sharp at 3x for a ~32px logo)
await sharp(path("docs/brand/mexuz-logo-original.png")).trim({ threshold: 20 }).resize({ height: 160 }).png({ compressionLevel: 9 }).toFile(path("src/assets/mexuz-logo.png"));
// the share image: the full logo on the app's light canvas, a thin brand line under it.
// The page title and description travel as text beside it, so the image carries no text.
{
  const W = 1200;
  const H = 630;
  const logo = await sharp(path("docs/brand/mexuz-logo-original.png")).trim({ threshold: 20 }).resize({ width: 640 }).png().toBuffer();
  const meta = await sharp(logo).metadata();
  const bg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#f4f6f8"/>` +
      `<rect x="${(W - 160) / 2}" y="${(H + meta.height) / 2 + 48}" width="160" height="8" rx="4" fill="#1e56d6"/></svg>`,
  );
  await sharp(bg)
    .composite([{ input: logo, left: Math.round((W - meta.width) / 2), top: Math.round((H - meta.height) / 2) - 16 }])
    .png({ compressionLevel: 9 })
    .toFile(path("src/app/opengraph-image.png"));
}
console.log("brand assets written");
