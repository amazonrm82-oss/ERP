import { z } from "zod";

// FXC-08: Server Action arguments that do not come from a form (booleans,
// choices, small objects) arrive from the browser as anything at all; the
// TypeScript types do not hold at runtime. Ids are checked by actionContext().

export const INVALID_ARGS = "הבקשה אינה תקינה. רעננו את הדף ונסו שוב.";

export const directionArg = z.enum(["up", "down"]);
export const booleanArg = z.boolean();
/** Optional free text from the browser (a reason, a user agent): a string or nothing. */
export const optionalTextArg = (max: number) => z.string().max(max * 4).nullish();

/** True when the value has the expected shape. */
export function validArg<T extends z.ZodType>(schema: T, value: unknown): value is z.infer<T> {
  return schema.safeParse(value).success;
}
