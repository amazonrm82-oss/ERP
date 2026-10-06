export type SupabaseEnv = { url: string; anonKey: string };

// NEXT_PUBLIC_* references are inlined at build time (server and browser), so
// they must be written out literally here. Returns null when either is missing;
// callers decide how to degrade (the root layout shows a configuration screen).
export function getSupabaseEnv(): SupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    return null;
  }
  return { url, anonKey };
}

export class MissingConfigError extends Error {
  constructor() {
    super("Supabase environment variables are not set");
    this.name = "MissingConfigError";
  }
}
