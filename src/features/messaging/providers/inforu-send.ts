/**
 * SMS-05: the Authorization header of InforU's v2 API (HTTP Basic). Takes the account's credentials as arguments and reads no
 * environment and no key name: inforu.ts stays the one reader of the account's keys (owner (318) א) and imports this file only
 * when it sends, so the pages that ask the adapter whether it is configured (the landing page, owner (339) ב) never load it.
 */
export function inforuBasicAuth(username: string, token: string): string {
  return `Basic ${Buffer.from(`${username}:${token}`, "utf8").toString("base64")}`;
}
