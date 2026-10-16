import { handleWidgetSubmit } from "@/features/site-widgets/public-server";

// SPD-07: the site widget's short form posts here (same-origin: the form page in the widget's frame)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleWidgetSubmit(request, token);
}
