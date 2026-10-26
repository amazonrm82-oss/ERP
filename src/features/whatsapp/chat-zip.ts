/**
 * WAB-07: the text file inside a WhatsApp "export chat" ZIP (the export "with media", or an iPhone's
 * export, which is always a ZIP). Runs in the browser before upload: it reads the ZIP's directory and
 * the one text entry only, through `read`, so the photos and videos in the archive are never read or
 * sent. The text is then parsed on the server like an uploaded .txt file.
 */

import { inflateSync } from "fflate";

import { CHAT_MAX_BYTES } from "./chat-import";

export type ZipReader = (start: number, end: number) => Promise<Uint8Array>;
export type ZipTextError = "not_zip" | "no_chat" | "too_big" | "unsupported";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
// the end record is 22 bytes plus a comment of up to 64 KB
const EOCD_SEARCH = 22 + 0xffff;
const MAX_ENTRIES = 100_000;

type Entry = { name: string; method: number; flags: number; compressed: number; size: number; offset: number };

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}
function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

function baseName(name: string): string {
  const parts = name.split("/");
  return parts[parts.length - 1];
}

/** The chat's text entry: "_chat.txt" (iPhone), else a "WhatsApp Chat …" / "צ'אט WhatsApp …" text file, else the only .txt. */
export function pickChatEntry<T extends { name: string }>(entries: T[]): T | null {
  const texts = entries.filter((entry) => !entry.name.endsWith("/") && /\.txt$/i.test(entry.name) && !baseName(entry.name).startsWith("."));
  return (
    texts.find((entry) => baseName(entry.name).toLowerCase() === "_chat.txt") ??
    texts.find((entry) => /whatsapp/i.test(baseName(entry.name))) ??
    (texts.length === 1 ? texts[0] : null)
  );
}

/** The bytes of the chat's text file inside a ZIP of `size` bytes, or why there are none. */
export async function chatTextFromZip(read: ZipReader, size: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: ZipTextError }> {
  if (size < 22) return { ok: false, reason: "not_zip" };
  const tailStart = Math.max(0, size - EOCD_SEARCH);
  const tail = await read(tailStart, size);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (u32(tail, i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) return { ok: false, reason: "not_zip" };
  const count = u16(tail, end + 10);
  const dirSize = u32(tail, end + 12);
  const dirOffset = u32(tail, end + 16);
  // ZIP64 (over 4 GB or 65,535 files) is not read
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) return { ok: false, reason: "unsupported" };
  if (dirOffset + dirSize > size || count > MAX_ENTRIES) return { ok: false, reason: "not_zip" };

  const dir = await read(dirOffset, dirOffset + dirSize);
  const entries: Entry[] = [];
  let at = 0;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > dir.length || u32(dir, at) !== CENTRAL) return { ok: false, reason: "not_zip" };
    const flags = u16(dir, at + 8);
    const nameLength = u16(dir, at + 28);
    const extraLength = u16(dir, at + 30);
    const commentLength = u16(dir, at + 32);
    const nameBytes = dir.subarray(at + 46, at + 46 + nameLength);
    // bit 11: the name is UTF-8; WhatsApp sets it, and older tools write plain ASCII names
    const name = new TextDecoder(flags & 0x800 ? "utf-8" : "latin1").decode(nameBytes);
    entries.push({ name, method: u16(dir, at + 10), flags, compressed: u32(dir, at + 20), size: u32(dir, at + 24), offset: u32(dir, at + 42) });
    at += 46 + nameLength + extraLength + commentLength;
  }

  const entry = pickChatEntry(entries);
  if (!entry) return { ok: false, reason: "no_chat" };
  // a stored entry is read as it is: its compressed size is its size
  if (entry.size > CHAT_MAX_BYTES || (entry.method === 0 && entry.compressed > CHAT_MAX_BYTES)) return { ok: false, reason: "too_big" };
  if (entry.flags & 0x1) return { ok: false, reason: "unsupported" };
  if (entry.method !== 0 && entry.method !== 8) return { ok: false, reason: "unsupported" };
  if (entry.compressed === 0xffffffff || entry.offset === 0xffffffff) return { ok: false, reason: "unsupported" };

  const local = await read(entry.offset, Math.min(size, entry.offset + 30));
  if (local.length < 30 || u32(local, 0) !== LOCAL) return { ok: false, reason: "not_zip" };
  const dataStart = entry.offset + 30 + u16(local, 26) + u16(local, 28);
  if (dataStart + entry.compressed > size) return { ok: false, reason: "not_zip" };
  const data = await read(dataStart, dataStart + entry.compressed);
  if (entry.method === 0) return { ok: true, bytes: data };
  try {
    // the output buffer is the size the directory states (at most CHAT_MAX_BYTES, checked above): an entry that inflates
    // to more than it claims does not fit and is refused, never grown
    const out = inflateSync(data, { out: new Uint8Array(entry.size) });
    return { ok: true, bytes: out };
  } catch {
    return { ok: false, reason: "not_zip" };
  }
}

/** A reader over a browser File (only the asked slices are read). */
export function fileZipReader(file: Blob): ZipReader {
  return async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());
}
