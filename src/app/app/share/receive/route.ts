import { NextResponse, type NextRequest } from "next/server";

import { SHARE_PAGE_PATH } from "@/features/share/share";

const toScreen = (request: NextRequest, query: string) =>
  NextResponse.redirect(new URL(`${SHARE_PAGE_PATH}${query}`, request.url), { status: 303, headers: { "Cache-Control": "no-store" } });

/**
 * WAB-06: where the phone sends a share. The service worker (public/sw.js) answers it on the device, so this route runs
 * only when no worker caught it (not installed yet, or a cleared browser). It reads nothing and keeps nothing: the text
 * and the image are dropped alike (never in an address, never logged), and the screen asks to open the app once and
 * share again, by which time the worker is in place.
 */
export function POST(request: NextRequest) {
  return toScreen(request, "?fallback=1");
}

/** Signed out during a share: the login page brings the person back here with GET; the share itself is gone. */
export function GET(request: NextRequest) {
  return toScreen(request, "?fallback=1");
}
