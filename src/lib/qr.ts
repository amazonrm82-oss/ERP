// A small QR code encoder (ISO/IEC 18004), no dependency (CAP-03).
// Byte mode (UTF-8), error correction level M (about 15% of the code can be
// damaged or covered), versions 1 to 40, the mask with the lowest penalty.
// Follows the structure of Project Nayuki's reference implementation (MIT).

/** A finished code: modules[y][x], true = dark. */
export type QrCode = { version: number; size: number; mask: number; modules: boolean[][] };

// Level M per version 1..40: error correction codewords per block, and blocks.
const ECC_PER_BLOCK_M = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const BLOCKS_M = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
// format information: level M is 00
const FORMAT_BITS_M = 0;

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

/** Modules that carry data and error correction (everything but the fixed patterns). */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords at level M. */
export function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK_M[version - 1] * BLOCKS_M[version - 1];
}

/** Centres of the alignment patterns, on both axes. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** The 15 format bits (level M, mask) with their BCH code and XOR mask. */
export function formatBits(mask: number): number {
  const data = (FORMAT_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up) with their BCH code. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// ---------------------------------------------------------------- Reed-Solomon over GF(256), 0x11D

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** Error correction codewords of one block. */
export function rsRemainder(data: number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

// ---------------------------------------------------------------- encoding

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Byte-mode segment, terminator and padding: the data codewords of a version. */
export function dataBytes(bytes: number[], version: number): number[] {
  const capacity = dataCodewords(version) * 8;
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  if (bits.length > capacity) throw new Error("the text does not fit this version");
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  return out;
}

/** Blocks with error correction, interleaved as they are placed. */
export function interleave(data: number[], version: number): number[] {
  const blocks = BLOCKS_M[version - 1];
  const eccLen = ECC_PER_BLOCK_M[version - 1];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = rsRemainder(block, eccLen);
    if (i < shortBlocks) block.push(0);
    all.push(block.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < all[0].length; i++) {
    all.forEach((block, j) => {
      // the placeholder byte of a short block is skipped
      if (i !== shortLen - eccLen || j >= shortBlocks) out.push(block[i]);
    });
  }
  return out;
}

// ---------------------------------------------------------------- the matrix

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly fixed: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFixed(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.fixed[y][x] = true;
  }

  drawPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFixed(6, i, i % 2 === 0);
      this.setFixed(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(size - 4, 3);
    this.finder(3, size - 4);
    const align = alignmentPositions(this.version);
    const n = align.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // not on the three finder corners
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) this.alignment(align[i], align[j]);
      }
    }
    this.drawFormat(0); // reserves the area; drawn again with the chosen mask
    this.drawVersion();
  }

  finder(cx: number, cy: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.setFixed(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  alignment(cx: number, cy: number) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFixed(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  drawFormat(mask: number) {
    const bits = formatBits(mask);
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.setFixed(8, i, bit(i));
    this.setFixed(8, 7, bit(6));
    this.setFixed(8, 8, bit(7));
    this.setFixed(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFixed(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFixed(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFixed(8, size - 15 + i, bit(i));
    this.setFixed(8, size - 8, true); // the dark module
  }

  drawVersion() {
    if (this.version < 7) return;
    const bits = versionBits(this.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFixed(a, b, dark);
      this.setFixed(b, a, dark);
    }
  }

  drawCodewords(codewords: number[]) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing line
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.fixed[y][x] && i < codewords.length * 8) {
            this.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.fixed[y][x] && maskBit(mask, x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }
}

/** Whether a mask flips the module at column x, row y. */
export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error("mask must be 0 to 7");
  }
}

/** The standard penalty of a finished matrix (lower is easier to scan). */
export function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    // N1: runs of five or more of one colour
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // N3: 1:1:3:1:1 finder-like patterns with four light modules on one side
    for (let i = 0; i + 7 <= size; i++) {
      if (get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6)) {
        const lightBefore = i >= 4 && [1, 2, 3, 4].every((d) => !get(i - d));
        const lightAfter = i + 11 <= size && [7, 8, 9, 10].every((d) => !get(i + d));
        if (lightBefore || lightAfter) score += 40;
      }
    }
  };
  for (let y = 0; y < size; y++) line((x) => modules[y][x]);
  for (let x = 0; x < size; x++) line((y) => modules[y][x]);
  // N2: 2x2 blocks of one colour
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  // N4: how far the share of dark modules is from half
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

/** The smallest version (from minVersion) that holds this many bytes at level M, or null. */
export function versionFor(byteLength: number, minVersion = QR_MIN_VERSION): number | null {
  for (let version = Math.max(QR_MIN_VERSION, minVersion); version <= QR_MAX_VERSION; version++) {
    const header = 4 + (version <= 9 ? 8 : 16);
    if (header + byteLength * 8 <= dataCodewords(version) * 8 && (version > 9 || byteLength < 256)) return version;
  }
  return null;
}

/**
 * Encodes text (UTF-8, byte mode, level M). `mask` forces a mask (tests);
 * otherwise the one with the lowest penalty is used.
 */
export function encodeQr(text: string, options: { mask?: number; minVersion?: number } = {}): QrCode {
  const bytes = utf8(text);
  const version = versionFor(bytes.length, options.minVersion);
  if (version === null) throw new Error("the text is too long for a QR code");
  const codewords = interleave(dataBytes(bytes, version), version);

  const build = (mask: number) => {
    const matrix = new Matrix(version);
    matrix.drawPatterns();
    matrix.drawCodewords(codewords);
    matrix.applyMask(mask);
    matrix.drawFormat(mask);
    return matrix;
  };
  let best: { mask: number; matrix: Matrix } | null = null;
  if (options.mask !== undefined) {
    best = { mask: options.mask, matrix: build(options.mask) };
  } else {
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const matrix = build(mask);
      const score = penalty(matrix.modules);
      if (score < bestScore) {
        bestScore = score;
        best = { mask, matrix };
      }
    }
  }
  const chosen = best as { mask: number; matrix: Matrix };
  return { version, size: chosen.matrix.size, mask: chosen.mask, modules: chosen.matrix.modules };
}

/** One SVG path of the dark modules, in module units, offset by a quiet zone of `border` modules. */
export function qrPath(code: QrCode, border = 4): string {
  const parts: string[] = [];
  code.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + border} ${y + border}h1v1h-1z`);
    });
  });
  return parts.join("");
}

/** A standalone SVG file of the code (for download), in the given colours. */
export function qrSvg(code: QrCode, colours: { dark: string; light: string }, border = 4): string {
  const dim = code.size + border * 2;
  const safe = (colour: string) => colour.replace(/[^#a-zA-Z0-9(),.%\s-]/g, "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${safe(colours.light)}"/>` +
    `<path d="${qrPath(code, border)}" fill="${safe(colours.dark)}"/>` +
    `</svg>`
  );
}
