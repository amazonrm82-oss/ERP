import type { MessagingProvider, OutgoingMessage, ProviderResult } from "./types";

/**
 * The fake provider (OPS-04): sends nothing. It records each message it is handed in an in-memory list of this server
 * process (ids and codes only, as the handler gives them), which tests read through fakeSentMessages(). No table, no
 * log line, no network. Used only when MESSAGING_PROVIDER=fake, and never on a production deployment (select.ts).
 */
const sent: OutgoingMessage[] = [];

export function fakeSentMessages(): readonly OutgoingMessage[] {
  return sent;
}

export function clearFakeSentMessages(): void {
  sent.length = 0;
}

export function createFakeProvider(options: { fail?: (message: OutgoingMessage) => ProviderResult | null } = {}): MessagingProvider {
  return {
    name: "fake",
    async send(message) {
      const failure = options.fail?.(message);
      if (failure && !failure.ok) return failure;
      sent.push({ ...message });
      return { ok: true, providerId: `fake-${sent.length}` };
    },
  };
}
