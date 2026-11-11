// DSN-18: the screenshot comparison's own logic (tests/visual/), with small made-up images.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { compareImages, comparePngBuffers, DEFAULTS, planComparison, verdict } from "../visual/compare.mjs";
import { decodePng, encodePng } from "../visual/png.mjs";
import { MASK, maskText } from "../visual/stabilize.mjs";

function image(width: number, height: number, rgba: [number, number, number, number] = [255, 255, 255, 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

function paint(img: ReturnType<typeof image>, count: number, rgba: [number, number, number, number]) {
  for (let i = 0; i < count; i++) img.data.set(rgba, i * 4);
  return img;
}

describe("png", () => {
  it("round-trips RGBA pixels", () => {
    const img = paint(image(7, 5, [10, 20, 30, 255]), 9, [200, 100, 50, 128]);
    const back = decodePng(encodePng(img));
    expect([back.width, back.height]).toEqual([7, 5]);
    expect(back.data.equals(img.data)).toBe(true);
  });

  it("reads an RGB image with every row filter (as Chromium writes)", () => {
    const width = 4;
    const height = 5;
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) % 256;
    // rows with filters 0..4, encoded by hand
    const raw: number[] = [];
    const stride = width * 3;
    for (let y = 0; y < height; y++) {
      const filter = y;
      raw.push(filter);
      for (let x = 0; x < stride; x++) {
        const v = rgb[y * stride + x];
        const a = x >= 3 ? rgb[y * stride + x - 3] : 0;
        const b = y > 0 ? rgb[(y - 1) * stride + x] : 0;
        const c = x >= 3 && y > 0 ? rgb[(y - 1) * stride + x - 3] : 0;
        const p = a + b - c;
        const pred = [0, a, b, (a + b) >> 1, Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c][filter];
        raw.push((v - pred + 256) % 256);
      }
    }
    const png = buildPng(width, height, 2, Buffer.from(raw));
    const read = decodePng(png);
    for (let i = 0; i < width * height; i++) {
      expect([...read.data.subarray(i * 4, i * 4 + 4)]).toEqual([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255]);
    }
  });

  it("refuses what it does not read", () => {
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/not a PNG/);
    expect(() => decodePng(buildPng(1, 1, 6, Buffer.from([0, 0, 0, 0, 0]), 16))).toThrow(/bit depth 16/);
  });
});

function buildPng(width: number, height: number, colorType: number, raw: Buffer, depth = 8) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(typed));
    return Buffer.concat([len, typed, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("compareImages", () => {
  it("passes identical images", () => {
    const r = compareImages(image(100, 100), image(100, 100));
    expect(r).toMatchObject({ ok: true, diffPixels: 0, ratio: 0, sizeMismatch: false });
  });

  it("ignores a colour shift within the tolerance (anti-aliasing)", () => {
    const shifted = paint(image(100, 100), 10_000, [255 - DEFAULTS.channelTolerance, 255, 255, 255]);
    expect(compareImages(image(100, 100), shifted).diffPixels).toBe(0);
    const over = paint(image(100, 100), 1, [255 - DEFAULTS.channelTolerance - 1, 255, 255, 255]);
    expect(compareImages(image(100, 100), over).diffPixels).toBe(1);
  });

  it("allows at most 0.1% of the pixels to differ", () => {
    // 100 x 100 = 10,000 pixels: 10 is exactly 0.1%, 11 is over
    expect(compareImages(image(100, 100), paint(image(100, 100), 10, [0, 0, 0, 255])).ok).toBe(true);
    const over = compareImages(image(100, 100), paint(image(100, 100), 11, [0, 0, 0, 255]));
    expect(over).toMatchObject({ ok: false, diffPixels: 11 });
    expect(over.ratio).toBeCloseTo(0.0011, 6);
  });

  it("takes its thresholds from the options", () => {
    const changed = paint(image(10, 10), 5, [0, 0, 0, 255]);
    expect(compareImages(image(10, 10), changed, { maxDiffRatio: 0.05 }).ok).toBe(true);
    expect(compareImages(image(10, 10), changed, { channelTolerance: 255 }).diffPixels).toBe(0);
  });

  it("blends transparency onto white before comparing", () => {
    expect(compareImages(image(4, 4, [0, 0, 0, 0]), image(4, 4)).diffPixels).toBe(0);
  });

  it("fails a change of size, counting the missing area as changed", () => {
    const r = compareImages(image(100, 100), image(100, 101));
    expect(r).toMatchObject({ ok: false, sizeMismatch: true, baselineSize: "100x100", actualSize: "100x101", diffPixels: 100 });
    expect([r.diff.width, r.diff.height]).toEqual([100, 101]);
  });

  it("marks the changed pixels red in the diff picture", () => {
    const r = compareImages(image(2, 1), paint(image(2, 1), 1, [0, 0, 0, 255]));
    expect([...r.diff.data.subarray(0, 4)]).toEqual([230, 0, 0, 255]);
    expect(r.diff.data[4]).toBe(255);
  });

  it("works on PNG files and gives a diff file only on a failure", () => {
    const same = comparePngBuffers(encodePng(image(20, 20)), encodePng(image(20, 20)));
    expect(same.ok).toBe(true);
    expect(same.diffPng).toBeNull();
    const changed = comparePngBuffers(encodePng(image(20, 20)), encodePng(paint(image(20, 20), 50, [0, 0, 0, 255])));
    expect(changed.ok).toBe(false);
    expect(decodePng(changed.diffPng!).width).toBe(20);
  });
});

describe("planComparison", () => {
  const shots = ["home-360.png", "home-1280.png", "leads-360.png"];

  it("with no baseline only hands over the shots (no failure)", () => {
    const plan = planComparison([], shots);
    expect(plan).toMatchObject({ seed: true, pairs: [] });
    expect(verdict(plan, [])).toMatchObject({ ok: true, seeded: true });
  });

  it("compares what both sides have and names new and gone shots", () => {
    const plan = planComparison(["home-360.png", "home-1280.png", "old-360.png", "README.md"], shots);
    expect(plan).toEqual({ seed: false, pairs: ["home-1280.png", "home-360.png"], added: ["leads-360.png"], removed: ["old-360.png"] });
  });

  it("fails only on a compared shot that changed", () => {
    const plan = planComparison(["home-360.png"], shots);
    expect(verdict(plan, [{ ok: true }]).ok).toBe(true);
    expect(verdict(plan, [{ ok: true }, { ok: false }]).failed).toHaveLength(1);
  });
});

describe("masking changing text", () => {
  it.each([
    ["נוצר ב-1.11.2026", `נוצר ב-${MASK}`],
    ["יום ראשון, 1 בנובמבר 2026", MASK],
    ["נובמבר 2026", MASK],
    ["09:30 - 10:00", `${MASK} - ${MASK}`],
    ["לפני 3 שעות", MASK],
    ["ממתין 25 דקות", `ממתין ${MASK}`],
    ["screens-mf3k2@example.test", MASK],
    ["/o/0b7c1f2e-1d2c-4b5a-9f00-1234567890ab/leads", `/o/${MASK}/leads`],
    ["2026-11-02", MASK],
    ["יום ראשון, 8 בנוב׳ 2026", MASK],
    ["נוצר ב-8 בנוב' 2026", `נוצר ב-${MASK}`],
    ["7 בינו׳", MASK],
    ["למחר", MASK],
    ["ליום העבודה הבא", MASK],
  ])("%s", (input, output) => {
    expect(maskText(input)).toBe(output);
  });

  it("keeps fixed text and amounts", () => {
    for (const text of ["לוי שיפוצים ובנייה", "‏48,500 ₪", "8 לידים", "משה כהן"]) expect(maskText(text)).toBe(text);
  });
});

describe("the CI job", () => {
  const ci = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");

  it("runs the comparison in the e2e job, after the flow, and keeps promote behind it", () => {
    const e2e = ci.slice(ci.indexOf("\n  e2e:"), ci.indexOf("\n  promote:"));
    expect(e2e.indexOf("node tests/visual/run.mjs")).toBeGreaterThan(e2e.indexOf("npm run test:e2e"));
    expect(ci).toMatch(/needs: \[checks, e2e\]/);
    expect(ci).toMatch(/workflow_dispatch:[\s\S]*screenshots:[\s\S]*options: \[compare, update\]/);
  });
});
