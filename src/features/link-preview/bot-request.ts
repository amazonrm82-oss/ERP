import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import { clientIp } from "@/lib/keyed-ip-hash";
import { isPreviewBot } from "@/lib/preview-bots";

import type { PreviewKind } from "./bot-preview";
import { getBotPreview } from "./preview-server";

// WAB-05 follow-up: a customer page asks this first. A listed preview bot (src/lib/preview-bots.ts) gets the preview only,
// and the page's own read (which counts views, and for a quote marks it viewed and tells its owner) is never called.

/** This request comes from a preview fetcher on the closed list. */
export const isPreviewBotRequest = cache(async (): Promise<boolean> => isPreviewBot((await headers()).get("user-agent")));

/** The bot's preview, read once per request (the metadata and the minimal page share it). */
export const loadBotPreview = cache(async (kind: PreviewKind, token: string) => getBotPreview(kind, token, clientIp(await headers())));
