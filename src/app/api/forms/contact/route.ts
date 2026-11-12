import { handleContact } from "@/features/landing/contact-server";

// LND-20 v2 (8): the landing page's "נחזור אליכם" form, through Turnstile and then the ordinary public intake
export async function POST(request: Request) {
  return handleContact(request);
}
