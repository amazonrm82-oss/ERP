import { readFileSync } from "node:fs";

import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import {
  CHAT_BODY_MAX,
  CHAT_ERRORS,
  CHAT_MAX_MESSAGES,
  chatEntry,
  isWhatsappImport,
  parseWhatsappChat,
  type ParsedChat,
} from "@/features/whatsapp/chat-import";
import { chatTextFromZip, pickChatEntry, type ZipReader } from "@/features/whatsapp/chat-zip";

// WAB-07: the export formats WhatsApp writes, by phone and language. Invisible marks are built from
// code points so this file holds none of them literally.
const LRM = String.fromCharCode(0x200e);
const RLM = String.fromCharCode(0x200f);
const BOM = String.fromCharCode(0xfeff);
const NNBSP = String.fromCharCode(0x202f);

function parsed(text: string): ParsedChat {
  const result = parseWhatsappChat(text);
  if (!result.ok) throw new Error(`not parsed: ${result.reason}`);
  return result.chat;
}

describe("parseWhatsappChat: Android", () => {
  it("reads a Hebrew export (day first, 24h, dots) with multi-line messages and notices", () => {
    const chat = parsed(
      [
        "31.12.2024, 22:15 - ההודעות והשיחות מוצפנות מקצה לקצה. אף אחד מחוץ לצ'אט הזה לא יכול לקרוא אותן.",
        "31.12.2024, 22:15 - דני כהן: שלום, רציתי לשאול על ההצעה",
        "יש לי עוד שאלה",
        "",
        "ועוד שורה",
        "01.01.2025, 08:05 - נועה: בוקר טוב! נחזור אליך היום",
        "01.01.2025, 08:06 - נועה: <המדיה הושמטה>",
      ].join("\n"),
    );
    expect(chat.systemLines).toBe(1);
    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[0]).toEqual({
      date: "2024-12-31",
      time: "22:15:00",
      author: "דני כהן",
      text: "שלום, רציתי לשאול על ההצעה\nיש לי עוד שאלה\n\nועוד שורה",
      media: false,
    });
    expect(chat.messages[1]).toMatchObject({ date: "2025-01-01", time: "08:05:00", author: "נועה" });
    expect(chat.messages[2].media).toBe(true);
  });

  it("reads an English US export (month first, 12h, two-digit year) with a narrow space before PM", () => {
    const chat = parsed(
      [
        "12/31/24, 10:15" + NNBSP + "PM - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.",
        "12/31/24, 10:15" + NNBSP + "PM - Dan: Hi there",
        "1/2/25, 12:05 AM - Noa: After midnight",
        "1/2/25, 12:30 PM - Noa: IMG-20250102-WA0001.jpg (file attached)",
      ].join("\n"),
    );
    expect(chat.messages.map((m) => [m.date, m.time, m.author])).toEqual([
      ["2024-12-31", "22:15:00", "Dan"],
      ["2025-01-02", "00:05:00", "Noa"],
      ["2025-01-02", "12:30:00", "Noa"],
    ]);
    expect(chat.messages[2].media).toBe(true);
  });

  it("decides day first when a first part is over 12, and month first when the second is", () => {
    expect(parsed("05/04/2024, 10:00 - A: x\n13/04/2024, 11:00 - A: y").messages[0].date).toBe("2024-04-05");
    expect(parsed("05/04/2024, 10:00 - A: x\n04/13/2024, 11:00 - A: y").messages[0].date).toBe("2024-05-04");
  });

  it("reads Hebrew 12-hour markers", () => {
    const chat = parsed('3/4/2024, 9:30 אחה"צ - דני: אחר הצהריים\n3/4/2024, 9:30 לפנה״צ - דני: בבוקר');
    expect(chat.messages.map((m) => m.time)).toEqual(["21:30:00", "09:30:00"]);
  });

  it("strips the BOM and bidi marks from names and text, and treats Windows line ends", () => {
    const chat = parsed(BOM + "31/12/2024, 22:15 - " + RLM + "דני" + RLM + ": " + LRM + "+972 50-123-4567" + "\r\nשורה שנייה\r\n");
    expect(chat.messages[0].author).toBe("דני");
    expect(chat.messages[0].text).toBe("+972 50-123-4567\nשורה שנייה");
  });
});

describe("parseWhatsappChat: iPhone", () => {
  it("reads a Hebrew iPhone export with seconds and notices marked by U+200E", () => {
    const chat = parsed(
      [
        LRM + "[31.12.2024, 22:15:30] משפחת כהן: " + LRM + "ההודעות והשיחות מוצפנות מקצה לקצה.",
        "[31.12.2024, 22:16:02] דני כהן: היי",
        "מה נשמע?",
        LRM + "[31.12.2024, 22:17:45] נועה: " + LRM + "התמונה הושמטה",
      ].join("\n"),
    );
    expect(chat.systemLines).toBe(1);
    expect(chat.messages).toEqual([
      { date: "2024-12-31", time: "22:16:02", author: "דני כהן", text: "היי\nמה נשמע?", media: false },
      { date: "2024-12-31", time: "22:17:45", author: "נועה", text: "התמונה הושמטה", media: true },
    ]);
  });

  it("reads an English iPhone export (12h, slashes)", () => {
    const chat = parsed(
      [
        "[12/31/24, 10:15:30" + NNBSP + "PM] Dan: Hello",
        "[1/1/25, 9:01:00 AM] Noa: " + LRM + "image omitted",
        "[1/1/25, 9:02:00 AM] Noa: " + LRM + "<attached: 00000012-PHOTO-2025-01-01.jpg>",
      ].join("\n"),
    );
    expect(chat.messages.map((m) => [m.date, m.time, m.media])).toEqual([
      ["2024-12-31", "22:15:30", false],
      ["2025-01-01", "09:01:00", true],
      ["2025-01-01", "09:02:00", true],
    ]);
  });
});

describe("parseWhatsappChat: refusals and limits", () => {
  it("refuses an empty file and a text that is not an export", () => {
    expect(parseWhatsappChat("")).toEqual({ ok: false, reason: "empty" });
    expect(parseWhatsappChat(BOM + "  \n ")).toEqual({ ok: false, reason: "empty" });
    expect(parseWhatsappChat("Dear Dan,\nhello\n")).toEqual({ ok: false, reason: "not_whatsapp" });
    // notices only
    expect(parseWhatsappChat("31/12/2024, 22:15 - Messages are end-to-end encrypted.")).toEqual({ ok: false, reason: "not_whatsapp" });
  });

  it("does not take an impossible date or time as a new message", () => {
    const chat = parsed("31/12/2024, 22:15 - A: one\n31/02/2024, 10:00 - B: not a date\n31/12/2024, 25:00 - B: not a time");
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].text).toContain("31/02/2024, 10:00 - B: not a date");
  });

  it("refuses more messages than the limit", () => {
    const line = "31/12/2024, 22:15 - A: x\n";
    expect(parseWhatsappChat(line.repeat(CHAT_MAX_MESSAGES + 1))).toEqual({ ok: false, reason: "too_many" });
    expect(parseWhatsappChat(line.repeat(CHAT_MAX_MESSAGES)).ok).toBe(true);
  });

  it("reads a long file in linear time", () => {
    const text = "31/12/2024, 22:15 - A: " + "[[[[(".repeat(50_000) + "\n";
    const started = Date.now();
    expect(parseWhatsappChat(text.repeat(3)).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // review H1: no input makes the header patterns or the trimming slow (the RVW-3 class of bug)
  const fast = (text: string) => {
    const started = performance.now();
    const result = parseWhatsappChat(text);
    return { result, ms: performance.now() - started };
  };

  it("parses 900 KB of spaces before a character quickly", () => {
    const { ms } = fast(" ".repeat(900 * 1024) + "x");
    expect(ms).toBeLessThan(200);
    const inMessage = fast("31/12/2024, 22:15 - A: x" + " ".repeat(900 * 1024) + "x\n" + " ".repeat(200_000));
    expect(inMessage.result.ok).toBe(true);
    expect(inMessage.ms).toBeLessThan(200);
  });

  it("parses a date prefix followed by 300,000 byte order marks or bidi marks quickly", () => {
    for (const mark of [BOM, LRM, RLM]) {
      const { ms } = fast("31/12/2024, 22:15" + mark.repeat(300_000) + "\n31/12/2024, 22:16 - A: x");
      expect(ms, `U+${mark.charCodeAt(0).toString(16)}`).toBeLessThan(200);
      const between = fast("31/12/2024," + mark.repeat(300_000) + " 22:15 - A: x");
      expect(between.ms).toBeLessThan(200);
    }
  });

  it("parses many lines of spaces and marks quickly", () => {
    const line = "31/12/2024, " + " ".repeat(60) + LRM.repeat(60) + "\n";
    const { ms } = fast("31/12/2024, 22:15 - A: x\n" + line.repeat(5000));
    // loose bound (it reached 236 ms under load); a quadratic pattern takes seconds here
    expect(ms).toBeLessThan(500);
  });

  it("still reads a header with marks inside it", () => {
    const chat = parsed(LRM + "[" + LRM + "31/12/2024, " + RLM + "22:15:30" + LRM + "] " + LRM + "Dan: hello");
    expect(chat.messages[0]).toMatchObject({ date: "2024-12-31", time: "22:15:30", author: "Dan", text: "hello" });
  });

  it("has a message for every refusal", () => {
    for (const key of ["no_file", "empty", "not_whatsapp", "too_many", "too_big", "no_chat", "unsupported"] as const) {
      expect(CHAT_ERRORS[key]).toMatch(/\S/);
    }
  });
});

describe("chatEntry", () => {
  const now = new Date("2025-06-01T12:00:00Z");

  it("makes one entry: header, messages oldest first, time of the last message in the business zone", () => {
    const chat = parsed("31.12.2024, 22:15 - דני: שלום\n01.01.2025, 08:05 - נועה: בוקר טוב\n01.01.2025, 08:06 - נועה: <המדיה הושמטה>");
    const entry = chatEntry(chat, "Asia/Jerusalem", now);
    // 08:06 in Jerusalem in winter is 06:06 UTC
    expect(entry.occurredAt).toBe("2025-01-01T06:06:00.000Z");
    expect(entry.metadata).toMatchObject({
      via: "import",
      kind: "whatsapp_import",
      first_message_at: "2024-12-31T20:15:00.000Z",
      last_message_at: "2025-01-01T06:06:00.000Z",
      message_count: 3,
      kept_count: 3,
      truncated: false,
      media_count: 1,
      participants: ["דני", "נועה"],
      participant_count: 2,
    });
    expect(entry.body.split("\n")).toEqual([
      "שיחת WhatsApp מיובאת: 3 הודעות, 31.12.2024 עד 01.01.2025.",
      "משתתפים: דני, נועה.",
      "קבצים מצורפים לא יובאו (1).",
      "",
      "31.12.2024 22:15 · דני: שלום",
      "01.01.2025 08:05 · נועה: בוקר טוב",
      "01.01.2025 08:06 · נועה: (קובץ מצורף, לא יובא)",
    ]);
  });

  it("never dates the entry after now", () => {
    const entry = chatEntry(parsed("31/12/2030, 22:15 - A: from the future"), "Asia/Jerusalem", now);
    expect(entry.occurredAt).toBe(now.toISOString());
    expect(entry.metadata.first_message_at).toBe(now.toISOString());
  });

  it("keeps the latest messages within the length limit and says so", () => {
    const lines: string[] = [];
    for (let i = 0; i < 2000; i += 1) lines.push(`01/03/2025, 10:${String(i % 60).padStart(2, "0")} - ${i % 2 ? "דני" : "נועה"}: הודעה מספר ${i}`);
    const entry = chatEntry(parsed(lines.join("\n")), "Asia/Jerusalem", now);
    expect(entry.body.length).toBeLessThanOrEqual(CHAT_BODY_MAX);
    expect(entry.metadata.truncated).toBe(true);
    expect(entry.metadata.message_count).toBe(2000);
    expect(entry.metadata.kept_count).toBeLessThan(2000);
    expect(entry.body).toContain(`נשמרו ${entry.metadata.kept_count.toLocaleString("he-IL")} ההודעות האחרונות מתוך 2,000.`);
    expect(entry.body.endsWith("הודעה מספר 1999")).toBe(true);
    expect(entry.body).not.toContain("הודעה מספר 0\n");
  });

  it("cuts a very long message and lists at most 20 participants", () => {
    const lines = ["01/03/2025, 10:00 - A: " + "x".repeat(5000)];
    for (let i = 0; i < 25; i += 1) lines.push(`01/03/2025, 10:01 - Person ${i}: hi`);
    const entry = chatEntry(parsed(lines.join("\n")), "Asia/Jerusalem", now);
    expect(entry.body).toContain("x".repeat(1500) + "…");
    expect(entry.metadata.participants).toHaveLength(20);
    expect(entry.metadata.participant_count).toBe(26);
    expect(entry.body).toContain("ועוד 6.");
  });

  it("lists the participants of 20,000 distinct authors in linear time, in order of first appearance (RVW-60)", () => {
    const messages = Array.from({ length: CHAT_MAX_MESSAGES }, (_, i) => ({
      date: "2025-03-01",
      time: "10:00:00",
      author: `כותב ${i}`,
      text: "שלום",
      media: false,
    }));
    // a repeated author keeps its first place
    messages[CHAT_MAX_MESSAGES - 1] = { ...messages[CHAT_MAX_MESSAGES - 1], author: "כותב 3" };
    const started = performance.now();
    const entry = chatEntry({ messages, systemLines: 0 }, "Asia/Jerusalem", now);
    // the old includes() loop alone took about 1.2 s here, and a new time-zone formatter per message about 6 s
    expect(performance.now() - started).toBeLessThan(2500);
    expect(entry.metadata.participant_count).toBe(CHAT_MAX_MESSAGES - 1);
    expect(entry.metadata.participants).toEqual(Array.from({ length: 20 }, (_, i) => `כותב ${i}`));
  });

  it("marks the entry for the timeline and the contact rules", () => {
    // owner's answer (ב): stored as an import note (GAP-12), never a contact type
    expect(isWhatsappImport("import_note", "whatsapp_import")).toBe(true);
    expect(isWhatsappImport("import_note", "import_note")).toBe(false);
    expect(isWhatsappImport("whatsapp", "whatsapp_import")).toBe(false);
  });
});

describe("chatTextFromZip", () => {
  const reader =
    (bytes: Uint8Array): ZipReader =>
    async (start, end) =>
      bytes.slice(start, end);
  const chatText = "[31.12.2024, 22:16:02] דני: היי\n";

  it("reads only the chat's text from an iPhone ZIP with media", async () => {
    const zip = zipSync({
      "_chat.txt": strToU8(chatText),
      "00000012-PHOTO-2025-01-01.jpg": new Uint8Array(5000).fill(7),
    });
    const result = await chatTextFromZip(reader(zip), zip.length);
    expect(result.ok && new TextDecoder().decode(result.bytes)).toBe(chatText);
  });

  it("reads a stored (uncompressed) Android entry", async () => {
    const zip = zipSync({ "WhatsApp Chat with Dan.txt": [strToU8(chatText), { level: 0 }], "IMG-1.jpg": new Uint8Array(10) });
    const result = await chatTextFromZip(reader(zip), zip.length);
    expect(result.ok && new TextDecoder().decode(result.bytes)).toBe(chatText);
  });

  it("refuses what is not a ZIP, or holds no chat", async () => {
    const plain = strToU8("hello world, this is not a zip file at all");
    expect(await chatTextFromZip(reader(plain), plain.length)).toEqual({ ok: false, reason: "not_zip" });
    const zip = zipSync({ "a.jpg": new Uint8Array(10) });
    expect(await chatTextFromZip(reader(zip), zip.length)).toEqual({ ok: false, reason: "no_chat" });
  });

  it("refuses a chat over the size limit before inflating it", async () => {
    const zip = zipSync({ "_chat.txt": new Uint8Array(1_000_000).fill(65) });
    expect(await chatTextFromZip(reader(zip), zip.length)).toEqual({ ok: false, reason: "too_big" });
  });

  it("refuses a stored (uncompressed) chat over the size limit", async () => {
    const zip = zipSync({ "_chat.txt": [new Uint8Array(1_000_000).fill(65), { level: 0 }] });
    expect(await chatTextFromZip(reader(zip), zip.length)).toEqual({ ok: false, reason: "too_big" });
  });

  it("picks the chat entry by name", () => {
    expect(pickChatEntry([{ name: "notes.txt" }, { name: "_chat.txt" }])?.name).toBe("_chat.txt");
    expect(pickChatEntry([{ name: "a.txt" }, { name: "WhatsApp Chat - Dan.txt" }])?.name).toBe("WhatsApp Chat - Dan.txt");
    expect(pickChatEntry([{ name: "a.txt" }, { name: "b.txt" }])).toBeNull();
    expect(pickChatEntry([{ name: "__MACOSX/._chat.txt" }, { name: "x.txt" }])?.name).toBe("x.txt");
  });
});

describe("WAB-07 wiring", () => {
  it("the server action writes the user's session only, never the service key", () => {
    const source = readFileSync("src/features/whatsapp/chat-import-actions.ts", "utf8");
    expect(source).not.toMatch(/supabase\/service/);
    expect(source).toMatch(/plainMentions\(sanitizeNote\(/);
    expect(source).toMatch(/rpc\("whatsapp_chat_import"/);
    expect(source).not.toMatch(/from\("activities"\)/);
  });
});
