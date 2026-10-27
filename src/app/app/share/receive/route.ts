import { NextResponse, type NextRequest } from "next/server";

import { readShareParams, SHARE_PAGE_PATH, shareQuery } from "@/features/share/share";

/**
 * WAB-06: where the phone sends a share. The service worker (public/sw.js) answers it on the device, so this route runs
 * only when no worker caught it (not installed yet, or a cleared browser). It never keeps anything: the text goes on to
 * the share screen in its address, and an image is dropped (the screen asks to share it again). Nothing is logged.
 */
export async function POST(request: NextRequest) {
  let title = "";
  let text = "";
  let url = "";
  let imageDropped = false;
  try {
    const form = await request.formData();
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    title = field("title");
    text = field("text");
    url = field("url");
    const image = form.get("image");
    imageDropped = typeof image === "object" && image !== null && image.size > 0;
  } catch {
    // an unreadable share opens the screen empty
  }
  const params = readShareParams({ title, text, url, image: imageDropped ? "dropped" : undefined });
  return NextResponse.redirect(new URL(`${SHARE_PAGE_PATH}${shareQuery(params)}`, request.url), {
    status: 303,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Signed out during a share: the login page brings the person back here with GET; the share itself is gone. */
export function GET(request: NextRequest) {
  return NextResponse.redirect(new URL(SHARE_PAGE_PATH, request.url), { status: 303, headers: { "Cache-Control": "no-store" } });
}
