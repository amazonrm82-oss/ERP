import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { listMyOrganizations } from "@/features/onboarding/queries";
import { findShortcut, LAST_ORG_COOKIE, shortcutOrg } from "@/features/shortcuts/shortcuts";
import { getSessionUser } from "@/lib/auth";
import { paths } from "@/lib/paths";

/**
 * USR-08: a shortcut of the installed app. Opens the screen in the business the person last worked in on this device;
 * with no usable one (never opened, left it, several businesses) the business picker decides. The pages themselves
 * check membership, two-step verification and a closed business as usual.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ target: string }> }) {
  const { target } = await params;
  const shortcut = findShortcut(target);
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), { headers: { "Cache-Control": "no-store" } });
  if (!shortcut) return to(paths.home);
  // the proxy already sent a signed-out visitor to the login page, with this address as `next`
  const user = await getSessionUser();
  if (!user) return to(paths.login);
  const organizations = await listMyOrganizations(user.id);
  const orgId = shortcutOrg((await cookies()).get(LAST_ORG_COOKIE)?.value, organizations.map((org) => org.id));
  return to(orgId ? shortcut.path(orgId) : paths.home);
}
