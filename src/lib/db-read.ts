// FXC-05: a database read that fails must not look like "not found", like zeros
// or like empty names. Pages read through `must()`, which throws (the nearest
// error.tsx shows a "something went wrong" screen); Server Actions check
// `error` themselves and return `fail(dbErrorMessage(error))`. The lint rule in
// eslint.config.mjs refuses `{ data }` without `error`, and `(await …).data`.

type ReadError = { message: string; code?: string | null };

export class DbReadError extends Error {
  constructor(what: string, cause: ReadError) {
    super(`database read failed: ${what}: ${cause.code ?? ""} ${cause.message}`);
    this.name = "DbReadError";
  }
}

type Result = { data: unknown; error: ReadError | null };

/** The data of a Supabase result, or a thrown DbReadError when the read failed. */
export function must<R extends Result>(result: R, what: string): Extract<R, { error: null }>["data"] {
  if (result.error) {
    throw new DbReadError(what, result.error);
  }
  return result.data as Extract<R, { error: null }>["data"];
}
