// SMS-06 (owner, 18 November 2026): an SMS is charged by its segments. Mirrors app.sms_segments (migration sms_packs); both
// run tests/unit/fixtures/sms-segments.json. A text of GSM-7 characters only is 1 segment up to 160 septets (an extension
// character counts 2), else ceil(septets / 153); any other text is UCS-2: 1 segment up to 70 UTF-16 units, else
// ceil(units / 67). An empty text is 0.

/** GSM 03.38 basic set (without the escape), as the SQL writes it. */
export const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" + "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
/** GSM 03.38 extension table: each character takes 2 septets. */
export const GSM_EXTENSION = "\f^{}\\[~]|€";

const BASIC = new Set(Array.from(GSM_BASIC));
const EXTENSION = new Set(Array.from(GSM_EXTENSION));

export function smsSegments(text: string | null | undefined): number {
  if (!text) return 0;
  let septets = 0;
  let units = 0;
  let gsm = true;
  for (const char of text) {
    units += (char.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
    if (!gsm) continue;
    if (BASIC.has(char)) septets += 1;
    else if (EXTENSION.has(char)) septets += 2;
    else gsm = false;
  }
  if (gsm) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  return units <= 70 ? 1 : Math.ceil(units / 67);
}
