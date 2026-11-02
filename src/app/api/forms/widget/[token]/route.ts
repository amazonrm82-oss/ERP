import { handleWidgetSubmit } from "@/features/site-widgets/public-server";
import { refusePublicRequest } from "@/lib/public-sender-server";

// SPD-07: the site widget's short form posts here (same-origin: the form page in the widget's frame)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב): the shared per-sender limit first, before the token is looked up
  const refused = await refusePublicRequest(request, "json");
  if (refused) return refused;
  return handleWidgetSubmit(request, token);
}
