import { inflateSync } from "node:zlib";

// QUO-06 test helper: reads the text back out of a PDF the renderer made, with no PDF library: the objects, the fonts'
// ToUnicode maps and the text operators of every page. Answers, per page, the lines from top to bottom, each line's
// pieces left to right as they are drawn (visual order), joined with a space between separately drawn pieces.

type Obj = { dict: string; stream: Buffer | null };

function objects(pdf: Buffer): Map<number, Obj> {
  const text = pdf.toString("latin1");
  const out = new Map<number, Obj>();
  const re = /(\d+) 0 obj\s*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const bodyStart = m.index + m[0].length;
    // a stream object: its "stream" keyword comes before the first "endobj" (its dictionary never holds one)
    const firstEnd = text.indexOf("endobj", bodyStart);
    const keyword = text.indexOf("stream", bodyStart);
    const s = keyword !== -1 && keyword < firstEnd ? /^(<<[\s\S]*>>)\s*stream\r?\n/.exec(text.slice(bodyStart, keyword + 8)) : null;
    const length = s ? /\/Length (\d+)(?! \d+ R)/.exec(s[1]) : null;
    if (s && length) {
      // a stream is sliced by its /Length: compressed bytes may hold any text, "endobj" included
      const start = bodyStart + s[0].length;
      const raw = pdf.subarray(start, start + Number(length[1]));
      out.set(Number(m[1]), { dict: s[1], stream: /\/FlateDecode/.test(s[1]) ? inflateSync(raw) : Buffer.from(raw) });
      re.lastIndex = start + Number(length[1]);
    } else {
      out.set(Number(m[1]), { dict: text.slice(bodyStart, firstEnd), stream: null });
      re.lastIndex = firstEnd;
    }
  }
  return out;
}

const ref = (dict: string, key: string) => {
  const m = new RegExp(`/${key} (\\d+) 0 R`).exec(dict);
  return m ? Number(m[1]) : null;
};

function hexChars(hex: string): string {
  let s = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return s;
}

function cmap(stream: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of stream.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]+>)/g)) {
      const from = parseInt(m[1], 16);
      const to = parseInt(m[2], 16);
      if (m[3].startsWith("[")) {
        // a ligature maps to several characters: <0066 0066 0069>
        const values = [...m[3].matchAll(/<([0-9a-fA-F\s]+)>/g)].map((v) => hexChars(v[1].replace(/\s+/g, "")));
        for (let g = from; g <= to; g++) map.set(g, values[g - from] ?? "");
      } else {
        const base = hexChars(m[3].slice(1, -1).replace(/\s+/g, ""));
        for (let g = from; g <= to; g++) map.set(g, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (g - from)));
      }
    }
  }
  for (const block of stream.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) map.set(parseInt(m[1], 16), hexChars(m[2].replace(/\s+/g, "")));
  }
  return map;
}

export type PdfPageText = { lines: string[]; pieces: Array<{ x: number; y: number; text: string }> };

/** The text of every page, in reading position (top to bottom; each line left to right as drawn). */
export function pdfText(bytes: Uint8Array): PdfPageText[] {
  const pdf = Buffer.from(bytes);
  const objs = objects(pdf);
  const unicodeOf = new Map<number, Map<number, string>>();
  const fontMap = (fontObj: number) => {
    if (!unicodeOf.has(fontObj)) {
      const toUnicode = ref(objs.get(fontObj)?.dict ?? "", "ToUnicode");
      unicodeOf.set(fontObj, toUnicode ? cmap(objs.get(toUnicode)?.stream?.toString("latin1") ?? "") : new Map());
    }
    return unicodeOf.get(fontObj)!;
  };
  const pages: PdfPageText[] = [];
  // pages in the order of the page tree's Kids
  const tree = [...objs.values()].find((o) => /\/Type \/Pages/.test(o.dict));
  const kids = tree ? [...(/\/Kids \[([^\]]*)\]/.exec(tree.dict)?.[1] ?? "").matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1])) : [];
  for (const pageId of kids) {
    const page = objs.get(pageId)!;
    const resourcesId = ref(page.dict, "Resources");
    const resources = resourcesId ? objs.get(resourcesId)!.dict : page.dict;
    const fonts = new Map<string, number>();
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "";
    for (const m of fontDict.matchAll(/\/(\w+) (\d+) 0 R/g)) fonts.set(m[1], Number(m[2]));
    const contents = objs.get(ref(page.dict, "Contents")!)!.stream!.toString("latin1");
    const pieces: PdfPageText["pieces"] = [];
    let font: Map<number, string> = new Map();
    let x = 0;
    let y = 0;
    for (const m of contents.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm|\/(\w+) [\d.]+ Tf|\[([^\]]*)\] TJ|<([0-9a-fA-F]*)> Tj/g)) {
      if (m[1] !== undefined) {
        x = Number(m[5]);
        y = Number(m[6]);
      } else if (m[7] !== undefined) {
        font = fontMap(fonts.get(m[7])!);
      } else {
        const hex = m[8] !== undefined ? [...m[8].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]).join("") : m[9];
        let text = "";
        for (let i = 0; i + 4 <= hex.length; i += 4) text += font.get(parseInt(hex.slice(i, i + 4), 16)) ?? "�";
        pieces.push({ x, y, text });
      }
    }
    // a line: pieces whose baselines are within a point of each other
    const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: string[] = [];
    let current: typeof pieces = [];
    for (const piece of sorted) {
      if (current.length > 0 && Math.abs(current[0].y - piece.y) > 1) {
        lines.push(current.map((p) => p.text).join(" "));
        current = [];
      }
      current.push(piece);
    }
    if (current.length > 0) lines.push(current.map((p) => p.text).join(" "));
    pages.push({ lines, pieces });
  }
  return pages;
}
