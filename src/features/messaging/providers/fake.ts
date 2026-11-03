import type { MessageChannel, MessagingProvider, OutgoingMessage, ProviderResult } from "./types";

/**
 * The fake adapter (OPS-04, MSG-01): sends nothing. It records each message it is handed in an in-memory list of this
 * server process (ids and codes only, as the handler gives them), which tests read through fakeSentMessages(). No table,
 * no log line, no network. Only the last FAKE_SENT_KEPT are kept. Chosen only by MESSAGING_PROVIDER_<CHANNEL>=fake or
 * MESSAGING_PROVIDER=fake, and never on a production or preview deployment (select.ts).
 */
export const FAKE_SENT_KEPT = 100;
const sent: OutgoingMessage[] = [];
let count = 0;

export function fakeSentMessages(): readonly OutgoingMessage[] {
  return sent;
}

export function clearFakeSentMessages(): void {
  sent.length = 0;
}

export function createFakeProvider(
  options: { channel?: MessageChannel; fail?: (message: OutgoingMessage) => ProviderResult | null } = {},
): MessagingProvider {
  return {
    name: "fake",
    channel: options.channel ?? "email",
    async send(message) {
      const failure = options.fail?.(message);
      if (failure && !failure.ok) return failure;
      sent.push({ ...message });
      if (sent.length > FAKE_SENT_KEPT) sent.splice(0, sent.length - FAKE_SENT_KEPT);
      count += 1;
      return { ok: true, providerId: `fake-${count}`, costAgorot: 0 };
    },
  };
}
