/**
 * An error message may echo part of its input: V8's JSON SyntaxError quotes about ten characters of it, which could be
 * the start of a token. Quoted runs become "…" and token-like runs (16+ letters, digits, - or _, with any dot-separated
 * parts after them, as in a JWT) become [redacted].
 */
export function redactLogText(text: string): string {
  return text.replace(/"[^"]*"/g, '"…"').replace(/[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)*/g, "[redacted]");
}
