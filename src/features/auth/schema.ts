import { z } from "zod";

import { requiredEmail, requiredText } from "@/lib/validation";

export const signInSchema = z.object({
  email: requiredEmail,
  // not trimmed: spaces can be part of a password
  password: z.string({ error: "יש להזין סיסמה." }).min(1, { error: "יש להזין סיסמה." }),
});

export const PASSWORD_MIN = 10;

const newPassword = z
  .string({ error: "יש לבחור סיסמה." })
  .min(PASSWORD_MIN, { error: `הסיסמה צריכה להכיל לפחות ${PASSWORD_MIN} תווים.` })
  .max(72, { error: "הסיסמה ארוכה מדי (עד 72 תווים)." });

export const signUpSchema = z.object({
  full_name: requiredText(120, "יש להזין שם מלא."),
  email: requiredEmail,
  password: newPassword,
});

export const forgotPasswordSchema = z.object({ email: requiredEmail });

export const newPasswordSchema = z
  .object({ password: newPassword, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], error: "הסיסמאות אינן זהות." });
