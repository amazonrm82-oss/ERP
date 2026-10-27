// WAB-05 follow-up (owner, 27 October 2026, DECISIONS.md "תצוגה מקדימה של קישור: בוטים ושם העסק", answer (1) ב): a messaging
// app that draws a link's preview fetches the page itself. Those fetchers, and only those on this CLOSED list, get the page's
// preview only (the business's display name and logo, through public.link_preview_public), so the page's own read never runs:
// no view is counted, a quote is not marked viewed, nobody is told, no automation runs. Any other User-Agent, a bot not on the
// list included, gets the normal page (owner: "בוט שלא ברשימה מקבל את הדף הרגיל").
//
// Each rule is narrow on purpose. A false match would show a real customer the bare preview page instead of their quote, so
// a rule names the fetcher's own product token, never a word an ordinary browser or an in-app browser carries (the WhatsApp,
// Facebook and Instagram in-app browsers send a normal "Mozilla/5.0 ..." string with FBAN / FB_IAB / Instagram markers, which
// match nothing here).
//
// Left out on purpose:
// - search engines (Googlebot, Bingbot, Applebot, ...): the customer pages are noindex; a crawler is not a preview;
// - fetchers we could not tie to a documented, stable product token (Viber, generic "bot" / "preview" words): a guess here can
//   hide a customer's page. A new entry is added with its source.

export type PreviewBotRule = {
  /** who sends it */
  name: string;
  /** matched against the whole User-Agent */
  pattern: RegExp;
  /** why it is on the list, and an example of the string */
  reason: string;
};

export const PREVIEW_BOTS: readonly PreviewBotRule[] = [
  {
    name: "WhatsApp",
    // only at the very start: "WhatsApp/2.23.20.0 A", "WhatsApp/2.2329.10 i". Signal's link previews send the same string.
    pattern: /^WhatsApp\/\d/i,
    reason: "the rep's own phone draws the preview when the link is pasted into a chat (the case the owner asked about)",
  },
  {
    name: "Facebook",
    pattern: /\bfacebookexternalhit\/\d/i,
    reason: "Facebook, Messenger and Instagram previews; also part of iMessage's preview string: facebookexternalhit/1.1",
  },
  {
    name: "Facebot",
    pattern: /\bFacebot\b/i,
    reason: "Facebook's second crawler token, sent alone or with facebookexternalhit (iMessage previews)",
  },
  {
    name: "Telegram",
    pattern: /^TelegramBot\b/i,
    reason: "Telegram's preview fetcher: TelegramBot (like TwitterBot)",
  },
  {
    name: "X",
    pattern: /\bTwitterbot\/\d/i,
    reason: "X (Twitter) cards: Twitterbot/1.0",
  },
  {
    name: "Slack",
    pattern: /^Slackbot-LinkExpanding\b/i,
    reason: "Slack's link unfurling only (not Slack's other bots): Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  },
  {
    name: "Discord",
    pattern: /\bDiscordbot\/\d/i,
    reason: "Discord's embeds: Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  },
  {
    name: "LinkedIn",
    pattern: /^LinkedInBot\/\d/i,
    reason: "LinkedIn posts and messages: LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient ...)",
  },
  {
    name: "Microsoft Teams / Skype",
    pattern: /\bSkypeUriPreview\b/i,
    reason: "Teams and Skype chat previews: ... SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com",
  },
];

/** The User-Agent is one of the preview fetchers on the closed list. Null, empty or anything else: a normal visitor. */
export function isPreviewBot(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  if (ua === "" || ua.length > 1000) return false;
  return PREVIEW_BOTS.some((rule) => rule.pattern.test(ua));
}
