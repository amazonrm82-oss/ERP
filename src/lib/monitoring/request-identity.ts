import { cleanIdentity, isCustomerPagePath, orgIdFromPath, type MonitoringIdentity } from "@/lib/monitoring/sentry-rules";

// OPS-05: the user and business a server error belongs to. The proxy already asks Auth who the visitor is; it writes the user
// id (a uuid only) on the request as x-crm-user-id, always overwriting a visitor's own header, and only on a page of the app
// (never a public page, so never a customer page). onRequestError reads it back with the business id from the path
// (/o/<uuid>/...). Ids only. No Node imports: the proxy uses this file too.

export const MONITORING_USER_HEADER = "x-crm-user-id";

/** The user id the proxy writes for a request: a signed-in visitor of a non-public page, else null (header removed). */
export function monitoringUserHeaderValue(userId: string | null | undefined, isPublicPage: boolean): string | null {
  if (isPublicPage) return null;
  return cleanIdentity({ userId }).userId;
}

type HeaderGetter = (name: string) => string | null;

/** The identity of a captured server error: the proxy's user header and the path's business, never on a customer page. */
export function monitoringIdentityOf(getHeader: HeaderGetter, path: string): MonitoringIdentity {
  const pathname = path.split("?")[0].split("#")[0];
  if (isCustomerPagePath(pathname)) return { userId: null, orgId: null };
  return cleanIdentity({ userId: getHeader(MONITORING_USER_HEADER), orgId: orgIdFromPath(pathname) });
}
