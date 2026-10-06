// create_invitation() makes the token from two uuids without dashes: 64 hex characters.
const TOKEN_RE = /^[0-9a-f]{64}$/;

export function isInvitationToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}
