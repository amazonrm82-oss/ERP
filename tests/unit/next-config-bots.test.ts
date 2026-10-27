import { describe, expect, it } from "vitest";

import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/html-bots";

import nextConfig, { HTML_LIMITED_BOTS } from "../../next.config";
import { PREVIEW_BOTS } from "@/lib/preview-bots";

// WAB-05 (review L3): htmlLimitedBots replaces Next's default list, so ours is the default plus the preview fetchers it lacks.
const SAMPLES: Record<string, string> = {
  WhatsApp: "WhatsApp/2.23.20.0 A",
  Facebook: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  Facebot: "Facebot",
  Telegram: "TelegramBot (like TwitterBot)",
  X: "Twitterbot/1.0",
  Slack: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  Discord: "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  LinkedIn: "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
  "Microsoft Teams / Skype": "Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com",
};

describe("next.config htmlLimitedBots (WAB-05)", () => {
  it("is set, keeps Next's whole default list and adds TelegramBot and Facebot", () => {
    expect(nextConfig.htmlLimitedBots).toBe(HTML_LIMITED_BOTS);
    expect(HTML_LIMITED_BOTS.source.startsWith(HTML_LIMITED_BOT_UA_RE.source)).toBe(true);
    expect(HTML_LIMITED_BOTS.flags).toContain("i");
    for (const ua of ["Mediapartners-Google", "Bingbot", "Twitterbot/1.0", "WhatsApp/2", "redditbot"]) expect(HTML_LIMITED_BOTS.test(ua), ua).toBe(true);
  });

  it("covers every preview fetcher on our closed list", () => {
    for (const rule of PREVIEW_BOTS) {
      const ua = SAMPLES[rule.name];
      expect(ua, rule.name).toBeDefined();
      expect(rule.pattern.test(ua), rule.name).toBe(true);
      expect(HTML_LIMITED_BOTS.test(ua), rule.name).toBe(true);
    }
  });
});
