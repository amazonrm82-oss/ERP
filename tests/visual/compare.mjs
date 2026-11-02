// Screenshot comparison (DSN-18): pure functions, unit-tested in tests/unit/visual-compare.test.ts.
//
// A pixel "differs" when any colour channel (after blending onto white) moves by more than
// `channelTolerance` (0..255). An image fails when the differing pixels are more than
// `maxDiffRatio` of the larger of the two images. A change of size is always a failure:
// a page that grew or shrank changed its appearance.
import { decodePng, encodePng } from "./png.mjs";

export const DEFAULTS = Object.freeze({ channelTolerance: 24, maxDiffRatio: 0.001 });

function blend(data, i) {
  const a = data[i + 3] / 255;
  return [data[i] * a + 255 * (1 - a), data[i + 1] * a + 255 * (1 - a), data[i + 2] * a + 255 * (1 - a)];
}

/**
 * @param {{ width: number, height: number, data: Buffer }} baseline
 * @param {{ width: number, height: number, data: Buffer }} actual
 * @param {{ channelTolerance?: number, maxDiffRatio?: number }} [options]
 */
export function compareImages(baseline, actual, options = {}) {
  const { channelTolerance, maxDiffRatio } = { ...DEFAULTS, ...options };
  const width = Math.max(baseline.width, actual.width);
  const height = Math.max(baseline.height, actual.height);
  const sizeMismatch = baseline.width !== actual.width || baseline.height !== actual.height;
  const diff = Buffer.alloc(width * height * 4);
  let diffPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      const inBase = x < baseline.width && y < baseline.height;
      const inActual = x < actual.width && y < actual.height;
      let differs = !inBase || !inActual;
      let shade = 255;
      if (inBase && inActual) {
        const b = blend(baseline.data, (y * baseline.width + x) * 4);
        const a = blend(actual.data, (y * actual.width + x) * 4);
        differs = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2])) > channelTolerance;
        // the unchanged picture, faded, so the red marks can be placed
        shade = Math.round(255 - (255 - (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2])) * 0.25);
      }
      if (differs) {
        diffPixels++;
        diff[d] = 230;
        diff[d + 1] = 0;
        diff[d + 2] = 0;
      } else {
        diff[d] = diff[d + 1] = diff[d + 2] = shade;
      }
      diff[d + 3] = 255;
    }
  }
  const ratio = width * height ? diffPixels / (width * height) : 0;
  return {
    ok: !sizeMismatch && ratio <= maxDiffRatio,
    sizeMismatch,
    baselineSize: `${baseline.width}x${baseline.height}`,
    actualSize: `${actual.width}x${actual.height}`,
    diffPixels,
    ratio,
    diff: { width, height, data: diff },
  };
}

/** Compare two PNG files' bytes; the diff comes back as PNG bytes. */
export function comparePngBuffers(baselinePng, actualPng, options) {
  const result = compareImages(decodePng(baselinePng), decodePng(actualPng), options);
  return { ...result, diff: undefined, diffPng: result.ok ? null : encodePng(result.diff) };
}

/**
 * What to do with a set of shots, given the baseline file names (`<screen>-<width>.png`).
 * - no baseline at all: `seed` (nothing to compare; the run only hands over fresh shots);
 * - shots without a baseline: `added` (a warning: a new screen, refresh the baselines);
 * - baselines without a shot: `removed` (a warning: a screen left the list);
 * - the rest: `pairs` to compare.
 * @param {string[]} baselineNames @param {string[]} shotNames
 */
export function planComparison(baselineNames, shotNames) {
  const base = new Set(baselineNames.filter((n) => n.endsWith(".png")));
  const shots = new Set(shotNames.filter((n) => n.endsWith(".png")));
  return {
    seed: base.size === 0,
    pairs: [...shots].filter((n) => base.has(n)).sort(),
    added: [...shots].filter((n) => !base.has(n)).sort(),
    removed: [...base].filter((n) => !shots.has(n)).sort(),
  };
}

/** The exit verdict: fails only on a real difference in a compared pair. */
export function verdict(plan, results) {
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, failed, seeded: plan.seed };
}
