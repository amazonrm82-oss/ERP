import { dispatchPush } from "@/features/notifications/push-server";

// Woken by the database every minute when there is something to push. Secret in the Authorization header.
export async function POST(request: Request) {
  return dispatchPush(request);
}
