import { widgetScriptToken } from "@/features/site-widgets/paths";
import { handleWidgetScript } from "@/features/site-widgets/public-server";

// SPD-07: the site widget's script, loaded by the business's own website (/f/w/<token>.js)
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const token = widgetScriptToken(file);
  if (!token) {
    return new Response("/* widget not found */\n", {
      status: 404,
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  return handleWidgetScript(token);
}
