import { COUNTRIES, isCountryCode } from "@/features/companies/countries";

/**
 * The country cell of a company import (CON-04): an ISO 3166-1 alpha-2 code in any
 * case ("gb"), the Hebrew name from COUNTRIES ("בריטניה"), or the English name
 * ("United Kingdom"). An ASCII ' or " in a Hebrew name counts as ׳ or ״.
 */

const fold = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

const hebrew = (text: string) => fold(text).replace(/'/g, "׳").replace(/"/g, "״");

let byName: Map<string, string> | null = null;

function names(): Map<string, string> {
  if (byName) return byName;
  const map = new Map<string, string>();
  let english: Intl.DisplayNames | null = null;
  try {
    english = new Intl.DisplayNames("en", { type: "region" });
  } catch {
    english = null;
  }
  for (const { code, name } of COUNTRIES) {
    map.set(hebrew(name), code);
    const en = english?.of(code);
    if (en && en !== code) map.set(fold(en), code);
  }
  // common short forms that are not ISO codes
  for (const [alias, code] of [
    ["uk", "GB"],
    ["usa", "US"],
    ["ארה״ב", "US"],
  ] as const) {
    map.set(alias, code);
  }
  byName = map;
  return map;
}

export const COUNTRY_UNKNOWN = (text: string) =>
  `לא זוהתה המדינה "${text}". אפשר לכתוב שם מדינה בעברית או קוד בן שתי אותיות באנגלית, למשל GB.`;

/** The ISO code for a non-empty country cell, or null when it is not recognized. */
export function importCountry(text: string): string | null {
  const value = text.trim();
  if (/^[A-Za-z]{2}$/.test(value) && isCountryCode(value.toUpperCase())) {
    return value.toUpperCase();
  }
  return names().get(hebrew(value)) ?? names().get(fold(value)) ?? null;
}
