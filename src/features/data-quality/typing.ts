import { normalizePhone } from "@/lib/phone";

// DQL-02: warnings while typing a phone or an email. Warnings only: saving is never blocked by
// them (the existing form validation still refuses what it always refused).

export type TypingWarning = { message: string; suggestion?: string };

/**
 * An Israeli number by the numbering plan: mobile 05X-XXXXXXX (10 digits), landline
 * 0X-XXXXXXX (9 digits, areas 2,3,4,8,9), 07X-XXXXXXX (10 digits), 1-800 / 1-700 style numbers,
 * and *XXXX short codes. A number with + and another country code only gets a length check.
 */
export function phoneWarning(input: string): TypingWarning | null {
  const value = input.trim();
  if (value === "") {
    return null;
  }
  const digits = value.replace(/[^0-9]/g, "");
  if (/^\*\d{2,5}$/.test(value.replace(/[\s-]/g, ""))) {
    return null;
  }
  if (digits.length < 3) {
    return { message: "המספר קצר מדי." };
  }
  // 1-800 / 1-700 / 1-599 numbers are typed without a leading 0 (normalizePhone reads them as foreign)
  if (!value.startsWith("+") && /^1(80|70|59)\d{7}$/.test(digits)) {
    return null;
  }
  const e164 = normalizePhone(value);
  if (!e164) {
    return null;
  }
  if (!e164.startsWith("+972")) {
    if (value.startsWith("+") || digits.startsWith("00")) {
      const length = e164.length - 1;
      return length >= 8 && length <= 15 ? null : { message: "מספר מחו״ל צריך 8 עד 15 ספרות עם קידומת המדינה." };
    }
    if (digits.startsWith("05")) {
      return { message: "למספר נייד יש 10 ספרות, למשל 050-1234567." };
    }
    // typed without the leading 0: "501234567"
    const fixed = `0${digits}`;
    if (isIsraeliNational(digits)) {
      return { message: "חסר 0 בתחילת המספר?", suggestion: fixed };
    }
    return { message: "המספר לא נראה כמו מספר ישראלי תקין. בדקו שאין ספרה חסרה או מיותרת." };
  }
  const national = e164.slice(4);
  if (isIsraeliNational(national)) {
    return null;
  }
  if (national.startsWith("5")) {
    return { message: "למספר נייד יש 10 ספרות, למשל 050-1234567." };
  }
  return { message: "המספר לא נראה כמו מספר ישראלי תקין. בדקו שאין ספרה חסרה או מיותרת." };
}

/** National significant number (no leading 0): mobile, landline, 07X or toll-free. */
function isIsraeliNational(national: string): boolean {
  return /^5\d{8}$/.test(national) || /^[23489]\d{7}$/.test(national) || /^7\d{8}$/.test(national) || /^1(80|70|59)\d{6,7}$/.test(national);
}

// Big mail providers people mistype. A domain close to one of them (but not one of the real
// domains below) gets "did you mean".
const PROVIDERS = ["gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "icloud.com", "walla.co.il", "walla.com", "hotmail.co.il", "outlook.co.il"];

// real domains that look like a typo of a provider: never "corrected"
const REAL_DOMAINS = new Set([
  ...PROVIDERS,
  "mail.com",
  "email.com",
  "gmx.com",
  "ymail.com",
  "live.com",
  "me.com",
  "mac.com",
  "msn.com",
  "aol.com",
  "yahoo.co.il",
  "bezeqint.net",
  "netvision.net.il",
  "012.net.il",
  "zahav.net.il",
  "smile.net.il",
  "protonmail.com",
  "proton.me",
  "hotmail.co.uk",
  "outlook.co.uk",
  "yahoo.co.uk",
  "hotmail.fr",
  "outlook.fr",
]);

// typos that the distance rule misses (another ending)
const KNOWN_TYPOS: Record<string, string> = {
  "gmail.co.il": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.il": "gmail.com",
  "walla.co": "walla.co.il",
  "walla.il": "walla.co.il",
  "wala.co.il": "walla.co.il",
  "hotmail.co": "hotmail.com",
  "hotmail.il": "hotmail.co.il",
  "gamil.co.il": "gmail.com",
};

/** Edit distance where swapping two neighbouring letters counts once (gmial = gmail + 1). */
export function typoDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** The provider a mistyped domain most likely meant, or null. */
export function suggestDomain(domain: string): string | null {
  const lower = domain.toLowerCase();
  if (REAL_DOMAINS.has(lower)) {
    return null;
  }
  if (KNOWN_TYPOS[lower]) {
    return KNOWN_TYPOS[lower];
  }
  let best: { provider: string; distance: number } | null = null;
  for (const provider of PROVIDERS) {
    const distance = typoDistance(lower, provider);
    if (distance <= 2 && (!best || distance < best.distance)) {
      best = { provider, distance };
    }
  }
  return best?.provider ?? null;
}

/** "התכוונתם ל-…?" for a common domain typo; a short note for an address that is not whole yet. */
export function emailWarning(input: string): TypingWarning | null {
  const value = input.trim();
  if (value === "") {
    return null;
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || value.indexOf("@") !== at) {
    return { message: "בכתובת אימייל יש @ אחד, למשל name@gmail.com." };
  }
  const domain = value.slice(at + 1);
  if (!/^[^\s.@]+(\.[^\s.@]+)+$/.test(domain)) {
    return { message: "חסר סיום לכתובת, למשל ‎.com או ‎.co.il." };
  }
  const suggestion = suggestDomain(domain);
  if (suggestion) {
    const fixed = `${value.slice(0, at)}@${suggestion}`;
    return { message: `התכוונתם ל-${suggestion}?`, suggestion: fixed };
  }
  return null;
}
