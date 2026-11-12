import { describe, expect, it } from "vitest";

import { marketingEnvelope } from "@/features/message-templates/envelope";
import { fillMessage, MESSAGE_MERGE_FIELDS, type MergeFieldKey, type MergeValues } from "@/features/message-templates/fields";
import { isGender } from "@/features/gender/gender";

import fixture from "./fixtures/sms-fill.json";

// SMS-05: the composer fills an SMS in the database (app.sms_fill over app.sms_marketing_envelope, migration sms_compose);
// these are the same cases, run through the app's own fillMessage() and marketingEnvelope(), so the two never drift
// (tests/db/352-sms-compose.test.ts runs them through SQL).

const KEY_OF = new Map<string, MergeFieldKey>(
  (Object.keys(MESSAGE_MERGE_FIELDS) as MergeFieldKey[]).map((key) => [MESSAGE_MERGE_FIELDS[key].token.slice(1, -1), key]),
);

function values(byName: Record<string, string | null>, gender: string | null): MergeValues {
  const out: MergeValues = isGender(gender) ? { gender } : {};
  for (const [name, value] of Object.entries(byName)) {
    const key = KEY_OF.get(name);
    if (key) out[key] = value;
  }
  return out;
}

describe("SMS-05: the SMS fill mirrors fillMessage() and marketingEnvelope()", () => {
  it.each(fixture.cases)("$name", (c) => {
    const body = c.envelope ? marketingEnvelope({ channel: "sms", messageType: "marketing", subject: null, body: c.text }).body : c.text;
    expect(fillMessage(body, values(c.values as Record<string, string | null>, c.gender))).toBe(c.expected);
  });
});
