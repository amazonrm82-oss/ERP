import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseEnv } from "@/lib/env";
import { safeNextPath } from "@/lib/paths";
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
  return NextResponse.redirect(new URL(safeNextPath(searchParams.get("next")), request.url));
}
