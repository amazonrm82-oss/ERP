// USR-01: profile photos live in the private bucket "avatars", one object per
// photo, named "<user id>/<random uuid>" (see migration profile_fields).

export const AVATARS_BUCKET = "avatars";
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH = new RegExp(`^(${UUID})/${UUID}$`);

/** True when the path is a photo object of this user. */
export function isOwnAvatarPath(path: unknown, userId: string): path is string {
  if (typeof path !== "string") return false;
  const match = PATH.exec(path);
  return match !== null && match[1] === userId;
}

/** A Hebrew message when the picked file cannot be a profile photo, else null. */
export function avatarFileProblem(file: { type: string; size: number }): string | null {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) return "אפשר להעלות תמונה מסוג JPG, PNG או WebP.";
  if (file.size > AVATAR_MAX_BYTES) return "התמונה גדולה מדי. אפשר עד 2 MB.";
  if (file.size === 0) return "הקובץ ריק.";
  return null;
}
