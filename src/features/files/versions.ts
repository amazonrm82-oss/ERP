// REC-07: versions of a file. Each file may name the earlier version it replaces (files.previous_id); a file no other
// file replaces is the current one. The database keeps the history one line (at most one newer version per file, and
// deleting a version links the newer one to the one before it).

export type Versioned = { id: string; previousId: string | null; createdAt: string };

export type VersionGroup<T extends Versioned> = {
  // the current version
  current: T;
  // the earlier versions, newest first
  earlier: T[];
};

/**
 * Groups files into their histories: the current versions in the order given, each with its earlier versions. An
 * earlier version the reader does not get (another note, or gone) simply ends the line.
 */
export function versionGroups<T extends Versioned>(files: T[]): VersionGroup<T>[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const replaced = new Set(files.flatMap((file) => (file.previousId && byId.has(file.previousId) ? [file.previousId] : [])));
  return files
    .filter((file) => !replaced.has(file.id))
    .map((current) => {
      const earlier: T[] = [];
      const seen = new Set([current.id]);
      let next = current.previousId ? byId.get(current.previousId) : undefined;
      while (next && !seen.has(next.id)) {
        earlier.push(next);
        seen.add(next.id);
        next = next.previousId ? byId.get(next.previousId) : undefined;
      }
      return { current, earlier };
    });
}
