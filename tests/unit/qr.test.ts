import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  alignmentPositions,
  dataBytes,
  dataCodewords,
  encodeQr,
  formatBits,
  maskBit,
  penalty,
  qrPath,
  qrSvg,
  rsRemainder,
  versionBits,
  versionFor,
} from "@/lib/qr";

// Reference matrices made once by another encoder (see "source" in the file).
const reference = JSON.parse(readFileSync(new URL("./qr-reference.json", import.meta.url), "utf8")) as {
  source: string;
  cases: Array<{ text: string; mask: number; version: number; rows: string[] }>;
};

const rows = (modules: boolean[][]) => modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));

describe("QR encoder (CAP-03)", () => {
  it("format bits of level M match ISO 18004 table C.1", () => {
    const table = ["101010000010010", "101000100100101", "101111001111100", "101101101001011", "100010111111001", "100000011001110", "100111110010111", "100101010100000"];
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((mask) => formatBits(mask).toString(2).padStart(15, "0"))).toEqual(table);
  });

  it("version bits match ISO 18004 table D.1", () => {
    expect([7, 8, 9, 10, 11, 20, 40].map((v) => versionBits(v).toString(16))).toEqual(["7c94", "85bc", "9a99", "a4d3", "bbf6", "149a6", "28c69"]);
  });

  it("capacity and alignment patterns per version", () => {
    // data codewords at level M (ISO table 7)
    expect([1, 2, 4, 7, 10, 20, 40].map(dataCodewords)).toEqual([16, 28, 64, 124, 216, 669, 2334]);
    // byte-mode capacity at level M: 14, 26, 42, 62 ... 2331
    expect([14, 15, 26, 27, 42, 62, 213, 214, 2331, 2332].map((n) => versionFor(n))).toEqual([1, 2, 2, 3, 3, 4, 10, 11, 40, null]);
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
  });

  it("Reed-Solomon matches the worked example of ISO 18004 annex I (1-M, '01234567')", () => {
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(rsRemainder(data, 10)).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });

  it("byte mode: header, terminator and the two pad codewords", () => {
    expect(dataBytes([0x41], 1)).toEqual([0x40, 0x14, 0x10, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec]);
  });

  it.each(reference.cases.map((c) => [c.text.slice(0, 24), c.version, c.mask, c] as const))(
    "matches a reference matrix: %s (version %i, mask %i)",
    (_name, version, mask, c) => {
      const code = encodeQr(c.text, { mask });
      expect(code.version).toBe(version);
      expect(code.size).toBe(version * 4 + 17);
      expect(rows(code.modules)).toEqual(c.rows);
    },
  );

  it("the fixed patterns are where a scanner looks for them", () => {
    const code = encodeQr("https://example.co.il/f/" + "a".repeat(32) + "?utm_source=qr");
    const { size, modules } = code;
    const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
    const cut = (x: number, y: number) => modules.slice(y, y + 7).map((row) => row.slice(x, x + 7).map((d) => (d ? "1" : "0")).join(""));
    expect(cut(0, 0)).toEqual(finder);
    expect(cut(size - 7, 0)).toEqual(finder);
    expect(cut(0, size - 7)).toEqual(finder);
    // separators are light, timing lines alternate, the dark module is dark
    for (let i = 0; i < 8; i++) expect([modules[7][i], modules[i][7], modules[7][size - 1 - i], modules[size - 8][i]]).toEqual([false, false, false, false]);
    for (let i = 8; i < size - 8; i++) expect([modules[6][i], modules[i][6]]).toEqual([i % 2 === 0, i % 2 === 0]);
    expect(modules[size - 8][8]).toBe(true);
    // both copies of the format information read back to the chosen mask
    const bits = formatBits(code.mask);
    const first = [0, 1, 2, 3, 4, 5, 7, 8].map((y) => modules[y][8]).concat([7, 5, 4, 3, 2, 1, 0].map((x) => modules[8][x]));
    const second = Array.from({ length: 8 }, (_, i) => modules[8][size - 1 - i]).concat(Array.from({ length: 7 }, (_, i) => modules[size - 7 + i][8]));
    const expected = Array.from({ length: 15 }, (_, i) => ((bits >>> i) & 1) === 1);
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
  });

  it("picks the mask with the lowest penalty", () => {
    const text = "https://crm.example.com/f/0123456789abcdef0123456789abcdef";
    const chosen = encodeQr(text);
    const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => penalty(encodeQr(text, { mask }).modules));
    expect(scores[chosen.mask]).toBe(Math.min(...scores));
    expect(maskBit(0, 1, 1)).toBe(true);
    expect(() => maskBit(8, 0, 0)).toThrow();
  });

  it("handles Hebrew (UTF-8) and refuses what does not fit", () => {
    expect(encodeQr("טופס פנייה").version).toBe(2); // 19 bytes
    expect(() => encodeQr("x".repeat(2332))).toThrow();
    expect(encodeQr("x".repeat(2331)).version).toBe(40);
  });

  it("draws as one SVG path with a quiet zone", () => {
    const code = encodeQr("A", { mask: 0 });
    const path = qrPath(code);
    expect(path.startsWith("M4 4h1v1h-1z")).toBe(true);
    expect(path.split("M").length - 1).toBe(code.modules.flat().filter(Boolean).length);
    const svg = qrSvg(code, { dark: "rgb(14, 28, 54)", light: "#fff\"><script>" });
    expect(svg).toContain('viewBox="0 0 29 29"');
    expect(svg).toContain('fill="rgb(14, 28, 54)"');
    expect(svg).not.toContain("<script>");
  });
});

describe("form QR link and file name (CAP-03)", () => {
  it("marks scans as coming from a QR code, and names the file after the form", async () => {
    const { formQrUrl, qrFileName } = await import("@/features/intake/qr-link");
    expect(formQrUrl("https://crm.example.com/f/abc")).toBe("https://crm.example.com/f/abc?utm_source=qr");
    expect(qrFileName("טופס צור קשר / 2026")).toBe("qr-טופס-צור-קשר-2026");
    expect(qrFileName("???")).toBe("qr-form");
  });
});
