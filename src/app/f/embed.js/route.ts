import { EMBED_SCRIPT } from "@/features/intake/embed-script";

// CAP-02: the optional script line of a form's embed code (see embed-script.ts).
// Under /f/ so it is public and may be loaded by customers' websites. The same
// text for everyone, built from code only; cached for a day by browsers and CDNs.
export function GET() {
  return new Response(EMBED_SCRIPT, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
