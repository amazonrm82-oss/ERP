import { widgetScriptToken } from "@/features/site-widgets/paths";
import { handleWidgetScript } from "@/features/site-widgets/public-server";
import { refusePublicRequest } from "@/lib/public-sender-server";

// SPD-07: the site widget's script, loaded by the business's own website (/f/w/<token>.js)
export async function GET(request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const token = widgetScriptToken(file);
  if (!token) {
    return new Response("/* widget not found */\n", {
      status: 404,
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  // OPS-02 (owner (40) ב): the shared per-sender limit before the token is looked up (only requests that reach the server count:
  // browsers and CDNs keep the script 5 minutes)
  const refused = await refusePublicRequest(request, "text");
  if (refused) return refused;
  return handleWidgetScript(token);
}
