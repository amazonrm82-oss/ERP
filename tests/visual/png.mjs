// A small PNG reader and writer for the screenshot comparison (DSN-18), so the
// comparison needs no package: 8-bit grey, grey+alpha, RGB, RGBA and palette images,
// not interlaced (what Chromium writes). Pixels come back as RGBA, 4 bytes each.
import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** @param {Buffer} buf @returns {{ width: number, height: number, data: Buffer }} */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colorType = body[9];
      if (depth !== 8 || !(colorType in CHANNELS)) throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colorType}`);
      if (body[12] !== 0) throw new Error("unsupported PNG: interlaced");
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (!width || !height) throw new Error("PNG without a header");
  const channels = CHANNELS[colorType];
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("PNG data is cut short");
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y > 0 ? pixels[out - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[out - stride + x - channels] : 0;
      let v;
      if (filter === 0) v = line[x];
      else if (filter === 1) v = line[x] + a;
      else if (filter === 2) v = line[x] + b;
      else if (filter === 3) v = line[x] + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`bad PNG filter ${filter}`);
      pixels[out + x] = v & 0xff;
    }
  }
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 6) pixels.copy(data, d, s, s + 4);
    else if (colorType === 2) {
      data[d] = pixels[s];
      data[d + 1] = pixels[s + 1];
      data[d + 2] = pixels[s + 2];
      data[d + 3] = 255;
    } else if (colorType === 0 || colorType === 4) {
      data[d] = data[d + 1] = data[d + 2] = pixels[s];
      data[d + 3] = colorType === 4 ? pixels[s + 1] : 255;
    } else {
      const index = pixels[s];
      if (!palette || index * 3 + 2 >= palette.length) throw new Error("PNG palette index out of range");
      data[d] = palette[index * 3];
      data[d + 1] = palette[index * 3 + 1];
      data[d + 2] = palette[index * 3 + 2];
      data[d + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** RGBA pixels to a PNG file. @param {{ width: number, height: number, data: Buffer }} image */
export function encodePng({ width, height, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
