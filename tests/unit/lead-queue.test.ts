import { describe, expect, it } from "vitest";

import { peekLinks } from "@/features/lead-peek/model";
import {
  QUEUE_MEMORY_ON,
  queueHref,
  queueLeft,
  queueLinks,
  queueMemoryKey,
  queueMemoryStep,
  queueNextId,
  queuePosition,
  queuePositionText,
  queueState,
} from "@/features/lead-peek/queue";

const ORG = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const LIST = `/o/${ORG}/leads/waiting`;

describe("UX-02: the waiting leads queue", () => {
  it("reads the mode from the address; anything else is off", () => {
    expect(queueState({ queue: "1" })).toBe("on");
    expect(queueState({ queue: "end" })).toBe("end");
    expect(queueState({ queue: ["1", "end"] })).toBe("on");
    expect(queueState({ queue: "yes" })).toBeNull();
    expect(queueState({})).toBeNull();
  });

  it("goes on in the list's own order, and ends after the last lead", () => {
    expect(queueNextId([A, B, C], A)).toBe(B);
    expect(queueNextId([A, B, C], B)).toBe(C);
    expect(queueNextId([A, B, C], C)).toBeNull();
    expect(queueNextId([A], A)).toBeNull();
  });

  it("starts again from the top when the lead is no longer on the list, never at the lead itself", () => {
    expect(queueNextId([B, C], A)).toBe(B);
    expect(queueNextId([], A)).toBeNull();
  });

  it("says the place in the queue", () => {
    expect(queuePosition([A, B, C], B)).toEqual({ at: 2, total: 3 });
    expect(queuePosition([A, B], C)).toBeNull();
    expect(queuePositionText({ at: 2, total: 3 })).toBe("מצב תור · 2 מתוך 3");
    expect(queuePositionText(null)).toBe("מצב תור");
  });

  it("keeps the page's other parameters and sets or clears the queue and the open lead", () => {
    const params = new URLSearchParams("who=all&queue=1");
    expect(queueHref(LIST, params, "on", B)).toBe(`${LIST}?who=all&queue=1&peek=${B}`);
    expect(queueHref(LIST, params, "end", null)).toBe(`${LIST}?who=all&queue=end`);
    expect(queueHref(LIST, params, null, A)).toBe(`${LIST}?who=all&peek=${A}`);
    expect(queueHref(LIST, new URLSearchParams(), null, null)).toBe(LIST);
  });

  it("after an action goes to the next lead, or to the end of the queue", () => {
    const peek = peekLinks(ORG, LIST, { who: "all", queue: "1", peek: A });
    expect(queueLinks(LIST, peek.params, [A, B], A)).toEqual({ afterHref: `${LIST}?who=all&queue=1&peek=${B}`, position: { at: 1, total: 2 } });
    expect(queueLinks(LIST, peek.params, [A, B], B).afterHref).toBe(`${LIST}?who=all&queue=end`);
  });

  it("a row clicked while in the queue stays in the queue (the panel's links keep the parameter)", () => {
    const peek = peekLinks(ORG, LIST, { queue: "1", peek: A });
    expect(peek.hrefFor(B)).toBe(`${LIST}?queue=1&peek=${B}`);
    expect(peek.closeHref).toBe(`${LIST}?queue=1`);
  });
});

describe("UX-02: the queue remembered on the device (owner 238 א)", () => {
  it("one key per business and user", () => {
    expect(queueMemoryKey(ORG, A)).toBe(`mx-lead-queue:${ORG}:${A}`);
    expect(queueMemoryKey(ORG, A)).not.toBe(queueMemoryKey(ORG, B));
  });

  it("leaving the queue goes to ?queue=off, which is off and forgets the choice", () => {
    const params = new URLSearchParams("who=all&queue=1");
    expect(queueHref(LIST, params, "off", A)).toBe(`${LIST}?who=all&queue=off&peek=${A}`);
    expect(queueState({ queue: "off" })).toBeNull();
    expect(queueLeft({ queue: "off" })).toBe(true);
    expect(queueLeft({ queue: "1" })).toBe(false);
    expect(queueLeft({})).toBe(false);
  });

  const base = { canWrite: true, state: null, left: false, stored: null, hasLead: true } as const;

  it("remembers while in the queue, also at its end", () => {
    expect(queueMemoryStep({ ...base, state: "on" })).toBe("remember");
    expect(queueMemoryStep({ ...base, state: "end", hasLead: false })).toBe("remember");
  });

  it("forgets when the person leaves, whatever was stored", () => {
    expect(queueMemoryStep({ ...base, left: true, stored: QUEUE_MEMORY_ON })).toBe("forget");
  });

  it("resumes only when last left on and a lead is waiting", () => {
    expect(queueMemoryStep({ ...base, stored: QUEUE_MEMORY_ON })).toBe("resume");
    expect(queueMemoryStep({ ...base, stored: QUEUE_MEMORY_ON, hasLead: false })).toBe("none");
    expect(queueMemoryStep({ ...base, stored: null })).toBe("none");
    expect(queueMemoryStep({ ...base, stored: "something else" })).toBe("none");
  });

  it("someone who cannot write never uses it", () => {
    expect(queueMemoryStep({ ...base, canWrite: false, stored: QUEUE_MEMORY_ON })).toBe("none");
    expect(queueMemoryStep({ ...base, canWrite: false, state: "on" })).toBe("none");
  });
});
