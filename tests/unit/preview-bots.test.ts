import { describe, expect, it } from "vitest";

import { isPreviewBot, PREVIEW_BOTS } from "@/lib/preview-bots";

// WAB-05 follow-up (owner, 27 October 2026, answer (1) ב): only the fetchers on the closed list skip the page. A false match
// would hide a real customer's quote behind the preview page, so the people's browsers (in-app ones included) must never match.

const BOTS = [
  "WhatsApp/2.23.20.0 A",
  "WhatsApp/2.2329.10 i",
  "whatsapp/2.24.1 W",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0",
  "Facebot",
  "TelegramBot (like TwitterBot)",
  "Twitterbot/1.0",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
  "Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com",
];

const PEOPLE = [
  // phones and computers
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  // in-app browsers: the customer who taps the link inside WhatsApp, Facebook, Instagram, Telegram or LinkedIn
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 WhatsApp/2.24.21.80",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0;FBBV/1;FBDV/iPhone15,2]",
  "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0;]",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0",
  "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 Telegram-Android/11.2.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30",
  // bots that are not previews: they get the normal page
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1)",
  "Slackbot 1.0 (+https://api.slack.com/robots)",
  "my-preview-bot/1.0",
  "",
];

describe("preview bots: a closed list (WAB-05)", () => {
  it("knows each listed fetcher, in any letter case", () => {
    for (const ua of BOTS) expect(isPreviewBot(ua), ua).toBe(true);
    expect(isPreviewBot("TWITTERBOT/1.0")).toBe(true);
    expect(isPreviewBot("telegrambot (like twitterbot)")).toBe(true);
  });

  it("never matches a person's browser, an in-app browser, a search engine or an unlisted bot", () => {
    for (const ua of PEOPLE) expect(isPreviewBot(ua), ua).toBe(false);
    expect(isPreviewBot(null)).toBe(false);
    expect(isPreviewBot(undefined)).toBe(false);
    expect(isPreviewBot("WhatsApp/2.24 " + "x".repeat(2000))).toBe(false);
  });

  it("every rule carries its reason, and each listed fetcher is matched by a rule of its own", () => {
    expect(PREVIEW_BOTS.length).toBe(9);
    for (const rule of PREVIEW_BOTS) {
      expect(rule.name.trim()).not.toBe("");
      expect(rule.reason.length).toBeGreaterThan(20);
      expect(rule.pattern.flags).toContain("i");
      expect(rule.pattern.flags).not.toContain("g");
      expect(BOTS.some((ua) => rule.pattern.test(ua)), rule.name).toBe(true);
    }
  });
});
