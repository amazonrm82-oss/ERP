// DQL-02: comparing a new company's name with the existing ones (findCompanyDuplicate).

/**
 * An ilike pattern for PostgREST that matches the name ignoring case and nothing wider than one
 * character per wildcard: "%", "_" and "\" are escaped, and "*" (which PostgREST turns into "%")
 * becomes "_". The few rows it brings back are then checked with sameCompanyName().
 */
export function companyNamePattern(name: string): string {
  return name
    .trim()
    .replace(/[\\%_]/g, (ch) => `\\${ch}`)
    .replace(/\*/g, "_");
}

/** The same name, ignoring case and outer spaces. */
export function sameCompanyName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}
