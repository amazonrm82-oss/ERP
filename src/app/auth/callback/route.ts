import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseEnv } from "@/lib/env";
import { paths, safeNextPath } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

const OTP_TYPES: readonly EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

function isOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value);
}

// Landing point of email confirmation links and OAuth sign-in.
// Exchanges the one-time code (or token hash) for a session cookie.
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const failure = new URL("/login?error=callback", request.url);

  if (!getSupabaseEnv()) {
    return NextResponse.redirect(failure);
  }

  const supabase = await createClient();
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  let succeeded = false;
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    succeeded = !error;
  } else if (tokenHash && isOtpType(type)) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    succeeded = !error;
  }

  if (!succeeded) {
    return NextResponse.redirect(failure);
  }
  const next = safeNextPath(searchParams.get("next"));
  // a session from a link (USR-10's one-time sign-in link, Google) is aal1 like a password sign-in: when the account has an
  // authenticator the code comes next, as signInAction does (the pages and the database refuse aal1 there anyway)
  // (asked on the same client, which holds the new session; the rule of owesSecondStep() in src/lib/auth.ts)
  let owesCode = false;
  const { data, error } = await supabase.rpc("mfa_status");
  if (!error && data && typeof data === "object" && !Array.isArray(data)) {
    const status = data as { enrolled?: unknown; aal?: unknown };
    owesCode = status.enrolled === true && status.aal !== "aal2";
  }
  // a failed read: the next page and the database judge the session anyway
  if (owesCode) {
    return NextResponse.redirect(new URL(`${paths.loginMfa}?next=${encodeURIComponent(next)}`, request.url));
  }
  return NextResponse.redirect(new URL(next, request.url));
}
