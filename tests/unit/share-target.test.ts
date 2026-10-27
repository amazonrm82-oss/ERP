import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";
import { DEFAULT_TERMS } from "@/features/terminology/terms";
import { SHARE_CACHE } from "@/features/share/device";
import { shareSearchHits, subjectFromPick } from "@/features/share/records";
import {
  clearEmail,
  clearPhone,
  cleanShared,
  IMAGE_ONLY_NOTE,
  recordPrefill,
  recordSavedLine,
  SHARED_FROM_PHONE,
  shareChoices,
  sharedNoteBody,
  noteStart,
  readShareParams,
  readStoredShare,
  SHARE_IMAGE_MAX_BYTES,
  SHARE_IMAGE_TYPES,
  SHARE_ITEM_PREFIX,
  SHARE_MAX_AGE_MS,
  SHARE_PAGE_PATH,
  SHARE_PREVIEW_TYPES,
  SHARE_RECEIVE_PATH,
  sharePath,
  sharePrefill,
  shareQuery,
  webUrl,
} from "@/features/share/share";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

describe("share target in the manifest (WAB-06)", () => {
  it("one POST multipart entry for title, text, url and one image of the allowed image types", () => {
    const m = manifest();
    expect(m.id).toBe("/");
    expect(m.share_target).toEqual({
      action: "/app/share/receive",
      method: "POST",
      enctype: "multipart/form-data",
      params: { title: "title", text: "text", url: "url", files: [{ name: "image", accept: SHARE_IMAGE_TYPES }] },
    });
    expect(SHARE_IMAGE_TYPES).toEqual(["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"]);
    // inside the app's scope, so Chrome hands the share to the installed app
    expect(m.share_target?.action.startsWith(m.scope ?? "/")).toBe(true);
  });

  it("the service worker answers the same addresses and limits", () => {
    const sw = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
    expect(sw).toContain(`const SHARE_RECEIVE_PATH = "${SHARE_RECEIVE_PATH}";`);
    expect(sw).toContain(`const SHARE_PAGE_PATH = "${SHARE_PAGE_PATH}";`);
    expect(sw).toContain(`const SHARE_ITEM_PREFIX = "${SHARE_ITEM_PREFIX}";`);
    expect(sw).toContain(`const SHARE_IMAGE_TYPES = ${JSON.stringify(SHARE_IMAGE_TYPES).replaceAll(",", ", ")};`);
    expect(SHARE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(sw).toContain("const SHARE_MAX_AGE_MS = 24 * 60 * 60 * 1000;");
    expect(SHARE_IMAGE_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(sw).toContain("const SHARE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;");
    expect(sw).toContain(`const SHARE_CACHE = "${SHARE_CACHE}";`);
    // the activate step keeps the share cache, as it keeps the offline page, and drops an old share
    expect(sw).toMatch(/key !== OFFLINE_CACHE && key !== SHARE_CACHE/);
    expect(sw).toMatch(/\.then\(\(\) => pruneShare\(\)\)/);
    // a share POST from another site is refused; each item is tied to the first person who opens it
    expect(sw).toContain('site && site !== "none" && site !== "same-origin"');
    expect(sw).toContain("item.owner !== owner");
  });

  it("the server fallback keeps nothing and passes no shared text on", () => {
    const route = readFileSync(new URL("../../src/app/app/share/receive/route.ts", import.meta.url), "utf8");
    expect(route).not.toMatch(/formData|searchParams\.set|title|text=/);
    expect(route).toContain('"?fallback=1"');
  });
});

describe("what counts as a phone or an email", () => {
  it("a whole value that is one email, or a mailto: link", () => {
    expect(clearEmail("Dana@Example.co.il")).toBe("dana@example.co.il");
    expect(clearEmail("  dana@example.com ")).toBe("dana@example.com");
    expect(clearEmail("mailto:dana%40example.com?subject=hi")).toBe("dana@example.com");
    expect(clearEmail("write to dana@example.com")).toBeNull();
    expect(clearEmail("dana@example.com, yossi@example.com")).toBeNull();
    expect(clearEmail("dana@localhost")).toBeNull();
    expect(clearEmail("@example.com")).toBeNull();
    expect(clearEmail("")).toBeNull();
  });

  it("a whole value that is one Israeli or international number, or a tel: link", () => {
    expect(clearPhone("050-1234567")).toBe("050-1234567");
    expect(clearPhone("03 123 4567")).toBe("03 123 4567");
    expect(clearPhone("(050) 123-4567")).toBe("(050) 123-4567");
    expect(clearPhone("+972 50 123 4567")).toBe("+972 50 123 4567");
    expect(clearPhone("00972501234567")).toBe("00972501234567");
    expect(clearPhone("tel:+972-50-1234567")).toBe("+972-50-1234567");
    expect(clearPhone("+1 212 555 0100")).toBe("+1 212 555 0100");
  });

  it("never a number inside a sentence, a short code, a date or a long digit run", () => {
    expect(clearPhone("call me at 050-1234567")).toBeNull();
    expect(clearPhone("050-1234567 דנה")).toBeNull();
    expect(clearPhone("1234")).toBeNull();
    expect(clearPhone("*6789")).toBeNull();
    expect(clearPhone("12.10.2026")).toBeNull();
    expect(clearPhone("123456789012")).toBeNull();
    expect(clearPhone("5012345678")).toBeNull();
    expect(clearPhone("+12")).toBeNull();
    expect(clearPhone("")).toBeNull();
  });
});

describe("links", () => {
  it("only http(s) addresses are kept as links", () => {
    expect(webUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(webUrl("http://example.com")).toBe("http://example.com/");
    expect(webUrl("javascript:alert(1)")).toBeNull();
    expect(webUrl("data:text/html,hi")).toBeNull();
    expect(webUrl("intent://x#Intent;end")).toBeNull();
    expect(webUrl("https://exa mple.com")).toBeNull();
    expect(webUrl("ftp://example.com")).toBeNull();
  });

  it("a text that is only a link becomes the link (many apps send it so)", () => {
    expect(cleanShared({ title: "Page", text: "https://example.com/x", url: "" })).toEqual({ title: "Page", text: "", url: "https://example.com/x" });
    expect(cleanShared({ text: "see https://example.com/x" })).toEqual({ title: "", text: "see https://example.com/x", url: null });
    expect(cleanShared({ url: "javascript:alert(1)", text: "hi" }).url).toBeNull();
  });
});

describe("prefill", () => {
  it("text, title and link go to the note, each once; nothing is guessed from a sentence", () => {
    const prefill = sharePrefill({ title: "מחירון", text: "שלום, אשמח להצעה 050-1234567", url: "https://example.com/p" });
    expect(prefill).toEqual({ note: "מחירון\nשלום, אשמח להצעה 050-1234567\nhttps://example.com/p", phone: null, email: null, url: "https://example.com/p" });
    expect(recordPrefill(prefill)).toEqual({});
  });

  it("a link already inside the text is not repeated, and a title the text starts with is left out", () => {
    expect(sharePrefill({ title: "Hi", text: "Hi there https://e.com/", url: "https://e.com/" }).note).toBe("Hi there https://e.com/");
  });

  it("a shared contact number or address is offered in its own field and not repeated in the note", () => {
    expect(sharePrefill({ text: "050-1234567" })).toEqual({ note: "", phone: "050-1234567", email: null, url: null });
    expect(sharePrefill({ title: "דנה כהן", text: "dana@example.com" })).toEqual({ note: "דנה כהן", phone: null, email: "dana@example.com", url: null });
    expect(sharePrefill({ url: "tel:0501234567" }).phone).toBe("0501234567");
    expect(sharePrefill({ url: "mailto:a@b.co" }).email).toBe("a@b.co");
    expect(recordPrefill(sharePrefill({ title: "דנה", text: "0501234567" }))).toEqual({ phone: "0501234567" });
    expect(recordPrefill(sharePrefill({ text: "dana@example.com", url: "tel:0501234567" }))).toEqual({ phone: "0501234567", email: "dana@example.com" });
  });

  it("a mention token in shared text is flattened, so nobody is told anything", () => {
    expect(sharePrefill({ text: `hi @[Dana](user:${ID})` }).note).toBe("hi @Dana");
  });

  it("the note is capped at 5,000 characters and an image alone still starts with a line", () => {
    expect(sharePrefill({ text: "א".repeat(9000) }).note.length).toBe(5000);
    expect(noteStart(sharePrefill({}), true)).toBe(IMAGE_ONLY_NOTE);
    expect(noteStart(sharePrefill({}), false)).toBe("");
    expect(noteStart(sharePrefill({ text: "x" }), true)).toBe("x");
  });
});

describe("a new lead or contact from a share (owner, 27 October 2026)", () => {
  it("the shared text is saved as a note marked on its first line; an image alone gets the mark; nothing = no note", () => {
    expect(sharedNoteBody("שלום\nhttps://e.com/", false)).toBe(`${SHARED_FROM_PHONE}\nשלום\nhttps://e.com/`);
    expect(sharedNoteBody("  x  ", true)).toBe(`${SHARED_FROM_PHONE}\nx`);
    expect(sharedNoteBody("", true)).toBe(SHARED_FROM_PHONE);
    expect(sharedNoteBody("   ", false)).toBeNull();
    expect(SHARED_FROM_PHONE).toBe("שותף מהטלפון");
  });

  it("the note with its mark still fits a note (5,000 characters)", () => {
    const body = sharedNoteBody(sharePrefill({ text: "א".repeat(9000) }).note, true);
    expect(body?.length).toBe(5000);
    expect(body?.startsWith(`${SHARED_FROM_PHONE}\n`)).toBe(true);
  });

  it("with leads switched off a new contact is offered instead of a new lead; a note on a record always", () => {
    expect(shareChoices(true)).toEqual(["lead", "note"]);
    expect(shareChoices(false)).toEqual(["contact", "note"]);
  });

  it("says the record was saved in the business's word and gender", () => {
    expect(recordSavedLine({ singular: "ליד", plural: "לידים", gender: "m", newOne: "ליד חדש", theSingular: "הליד", thePlural: "הלידים" })).toBe("הליד נשמר.");
    expect(recordSavedLine({ singular: "פנייה", plural: "פניות", gender: "f", newOne: "פנייה חדשה", theSingular: "הפנייה", thePlural: "הפניות" })).toBe("הפנייה נשמרה.");
  });
});

describe("the share screen's address", () => {
  it("carries only a valid share id or a flag, never what was shared", () => {
    const params = readShareParams({ s: ID.toUpperCase(), title: "t", text: "secret 050-1234567", url: "https://e.com/" });
    expect(params).toEqual({ s: ID, fallback: false, failed: false });
    expect(sharePath(ORG, params)).toBe(`/o/${ORG}/share?s=${ID}`);
    expect(readShareParams({ s: "../../etc" }).s).toBeNull();
    expect(shareQuery(readShareParams({}))).toBe("");
    expect(shareQuery(readShareParams({ fallback: "1", text: "x" }))).toBe("?fallback=1");
    expect(shareQuery(readShareParams({ failed: "1" }))).toBe("?failed=1");
  });

  it("reads what the worker kept for this person only, and forgets it after 24 hours or when the image is not attachable", () => {
    const now = 1_800_000_000_000;
    const owner = "a".repeat(64);
    const row = { title: "t", text: "x", url: "https://e.com/", image: { name: "a.jpg", type: "image/jpeg", size: 10 }, imageRefused: false, owner, at: now - 1000 };
    expect(readStoredShare(row, now, owner)).toEqual({ title: "t", text: "x", url: "https://e.com/", image: row.image, imageRefused: false, at: row.at });
    expect(readStoredShare(row, now, "b".repeat(64))).toBeNull();
    expect(readStoredShare({ ...row, owner: undefined }, now, owner)).toBeNull();
    expect(readStoredShare(row, now, "")).toBeNull();
    expect(readStoredShare({ ...row, at: now - SHARE_MAX_AGE_MS - 1 }, now, owner)).toBeNull();
    expect(readStoredShare({ ...row, image: { name: "a.svg", type: "image/svg+xml", size: 10 } }, now, owner)?.image).toBeNull();
    expect(readStoredShare({ ...row, image: { name: "a.jpg", type: "image/jpeg", size: SHARE_IMAGE_MAX_BYTES + 1 } }, now, owner)?.image).toBeNull();
    expect(readStoredShare(null, now, owner)).toBeNull();
    expect(readStoredShare("x", now, owner)).toBeNull();
  });

  it("HEIC is named, not previewed", () => {
    expect(SHARE_PREVIEW_TYPES).not.toContain("image/heic");
    expect(SHARE_IMAGE_TYPES.filter((type) => !SHARE_PREVIEW_TYPES.includes(type))).toEqual(["image/heic"]);
  });
});

describe("the record picker", () => {
  const answer = {
    leads: [{ id: ID, title: "דנה", subtitle: "050" }],
    contacts: [{ id: ORG, title: null, subtitle: null }, { id: "not-a-uuid", title: "x" }],
    companies: [{ id: ID, title: "חברה בע\"מ", subtitle: null }],
    deals: [{ id: ID, title: "עסקה", subtitle: "x", amount_agorot: 100 }],
  };

  it("contacts, leads, deals and companies, each in the business's word, ids typed by kind", () => {
    const hits = shareSearchHits(answer, { leads: true, companies: true }, DEFAULT_TERMS);
    expect(hits.map((hit) => hit.id)).toEqual([`contact:${ORG}`, `lead:${ID}`, `deal:${ID}`, `company:${ID}`]);
    expect(hits[0]).toEqual({ id: `contact:${ORG}`, label: `${DEFAULT_TERMS.contact.singular} ללא שם`, detail: DEFAULT_TERMS.contact.singular });
    expect(hits[1].detail).toBe(`${DEFAULT_TERMS.lead.singular} · 050`);
  });

  it("leaves out a switched-off module (LEAD-08) and nothing breaks on a bad answer", () => {
    const hits = shareSearchHits(answer, { leads: false, companies: false }, DEFAULT_TERMS);
    expect(hits.map((hit) => hit.id)).toEqual([`contact:${ORG}`, `deal:${ID}`]);
    expect(shareSearchHits(null, { leads: true, companies: true }, DEFAULT_TERMS)).toEqual([]);
  });

  it("a pick back to a record, nothing else", () => {
    expect(subjectFromPick(`deal:${ID}`)).toEqual({ kind: "deal", id: ID });
    expect(subjectFromPick(`task:${ID}`)).toBeNull();
    expect(subjectFromPick(`deal:${ID}:x`)).toBeNull();
    expect(subjectFromPick("deal:x")).toBeNull();
    expect(subjectFromPick(null)).toBeNull();
  });
});
