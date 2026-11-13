import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { META_WEBHOOK_KEYS, providerReadiness, waitingForProvider } from "@/features/landing/provider-readiness";
import { HIGHLIGHTED_PLAN_KEY, pricingFootnote, SOON_LINE } from "@/features/landing/pricing";
import { metaGraphProvider } from "@/features/meta-leads/graph/select";
import { messagingProviderFor } from "@/features/messaging/providers/select";
import { PLAN_CAPABILITIES } from "@/features/plans/capabilities";

// owner (339) ב: a built capability is "בקרוב" on the landing page while its real provider is not configured, judged from the
// provider configuration exactly as the senders judge it.
const NAMES = ["", "fake", "inforu", "sms4free", "resend", "sendgrid", "twilio", "graph", "meta", "INFORU"];
// the adapter's own key names (tests may write them; the lint rule covers src/)
const KEYS = { INFORU_USERNAME: "u", INFORU_API_TOKEN: "t", INFORU_SENDER: "Mexuz", RESEND_API_KEY: "re_x", RESEND_FROM: "noreply@mexuz.test" };

describe("landing: capabilities waiting for a provider (owner (339) ב)", () => {
  it("SMS and email readiness equal the real selector (a real adapter with its keys, never the fake)", () => {
    for (const name of NAMES) {
      for (const withKeys of [false, true]) {
        for (const vercel of ["", "production"]) {
          for (const shape of ["channel", "shared"] as const) {
            const env: Record<string, string> = { ...(withKeys ? KEYS : {}), VERCEL_ENV: vercel };
            if (shape === "channel") {
              env.MESSAGING_PROVIDER_SMS = name;
              env.MESSAGING_PROVIDER_EMAIL = name;
            } else env.MESSAGING_PROVIDER = name;
            const real = (channel: "sms" | "email") => messagingProviderFor(channel, env) !== null && name.toLowerCase() !== "fake";
            const ready = providerReadiness(env);
            expect(ready.sms, `${name} ${withKeys} ${vercel} ${shape}`).toBe(real("sms"));
            expect(ready.email, `${name} ${withKeys} ${vercel} ${shape}`).toBe(real("email"));
          }
        }
      }
    }
    expect(providerReadiness({ MESSAGING_PROVIDER_SMS: "inforu", ...KEYS }).sms).toBe(true);
    expect(providerReadiness({ MESSAGING_PROVIDER_SMS: "inforu", INFORU_USERNAME: "u" }).sms).toBe(false);
    // EML-01: Resend with its key and a plain sender address
    expect(providerReadiness({ MESSAGING_PROVIDER_EMAIL: "resend", ...KEYS }).email).toBe(true);
    expect(providerReadiness({ MESSAGING_PROVIDER_EMAIL: "resend", RESEND_API_KEY: "re_x", RESEND_FROM: "not an address" }).email).toBe(false);
  });

  it("Meta is ready only with a real Graph adapter and the webhook's keys (only the fake exists today)", () => {
    const keys = Object.fromEntries(META_WEBHOOK_KEYS.map((k) => [k, "x"]));
    for (const name of NAMES) {
      const env = { META_LEADS_PROVIDER: name, ...keys };
      const real = metaGraphProvider(env) !== null && name.toLowerCase() !== "fake";
      expect(providerReadiness(env).meta, name).toBe(real);
    }
  });

  it("marks the four capabilities while nothing is configured, and only booleans leave the server", () => {
    const waiting = waitingForProvider(providerReadiness({}));
    expect(waiting.sort()).toEqual(["meeting_reminders", "meta_leads", "review_requests", "sms"]);
    for (const feature of waiting) expect(PLAN_CAPABILITIES.some((c) => c.feature === feature && c.built)).toBe(true);
    expect(waitingForProvider({ sms: true, email: false, meta: true })).toEqual([]);
    expect(waitingForProvider({ sms: false, email: true, meta: true })).toEqual(["sms"]);
    const page = readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
    expect(page).toContain("waitingForProvider(providerReadiness())");
    expect(page).not.toMatch(/process\.env/);
  });

  it("the soon line shows only while a tag shows", () => {
    expect(pricingFootnote(true)).toContain(SOON_LINE);
    expect(pricingFootnote(false)).not.toContain(SOON_LINE);
    expect(HIGHLIGHTED_PLAN_KEY).toBe("pro");
  });
});
