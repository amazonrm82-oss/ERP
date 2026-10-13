import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { managesTeamChain } from "@/features/activities/schema";
import { isOwnTakeRequest, parseTakeOutcome, TAKE_HEADER, takeMessage, takenLabel, takenLeadsFilter } from "@/features/leads/take";
import { LEAD_PUSH_ACTIONS, pushPayload, type ClaimedNotification } from "@/features/notifications/push-payload";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";

const note = (extra: Partial<ClaimedNotification> = {}): ClaimedNotification => ({
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: ORG,
  user_id: "44444444-4444-4444-8444-444444444444",
  title: "ליד חדש הוקצה לכם",
  body: null,
  entity_type: "lead",
  entity_id: LEAD,
  organization_name: "עסק",
  ...extra,
});

describe("new-lead push payload (SPD-01)", () => {
  it("a lead with buttons opens the short screen and says where each button goes", () => {
    const payload = pushPayload(note({ type: "assigned", lead_actions: true, body: "ביקשו שנחזור אליהם עכשיו" }));
    expect(payload).toEqual({
      title: "ליד חדש הוקצה לכם",
      body: "עסק: ביקשו שנחזור אליהם עכשיו",
      url: `/o/${ORG}/leads/${LEAD}/respond`,
      tag: "33333333-3333-4333-8333-333333333333",
      actions: [
        { action: "take", title: "לקחתי" },
        { action: "call", title: "חיוג" },
        { action: "whatsapp", title: "WhatsApp" },
      ],
      links: {
        take: `/o/${ORG}/leads/${LEAD}/take`,
        call: `/o/${ORG}/leads/${LEAD}/respond?do=call`,
        whatsapp: `/o/${ORG}/leads/${LEAD}/respond?do=whatsapp`,
      },
    });
    // "לקחתי" first: a browser with two buttons keeps take and call
    expect(LEAD_PUSH_ACTIONS.map((a) => a.action)).toEqual(["take", "call", "whatsapp"]);
  });

  it("carries no lead data beyond the notification's own title and body", () => {
    const text = JSON.stringify(pushPayload(note({ lead_actions: true })));
    expect(text).not.toMatch(/tel:|wa\.me|\+972|05\d/);
  });

  it("any other notification keeps the old shape", () => {
    expect(pushPayload(note({ type: "assigned", lead_actions: false }))).toEqual({
      title: "ליד חדש הוקצה לכם",
      body: "עסק",
      url: `/o/${ORG}/leads/${LEAD}`,
      tag: "33333333-3333-4333-8333-333333333333",
    });
    // an older database that sends neither key
    expect(Object.keys(pushPayload(note()))).toEqual(["title", "body", "url", "tag"]);
    // lead_actions on something that is not a lead is ignored
    expect(pushPayload(note({ entity_type: "task", lead_actions: true })).url).toBe(`/o/${ORG}/tasks`);
    expect(pushPayload(note({ entity_type: null, entity_id: null, lead_actions: true })).url).toBe(`/o/${ORG}/notifications`);
  });
});

describe("take outcome (SPD-01)", () => {
  it("reads every answer of take_lead() and nothing else", () => {
    expect(parseTakeOutcome({ ok: true, result: "taken" })).toEqual({ ok: true, result: "taken" });
    expect(parseTakeOutcome({ ok: true, result: "acknowledged" })).toEqual({ ok: true, result: "acknowledged" });
    expect(parseTakeOutcome({ ok: false, reason: "taken", owner_name: " דנה " })).toEqual({ ok: false, reason: "taken", ownerName: "דנה" });
    expect(parseTakeOutcome({ ok: false, reason: "taken", owner_name: null })).toEqual({ ok: false, reason: "taken", ownerName: null });
    expect(parseTakeOutcome({ ok: false, reason: "closed" })).toEqual({ ok: false, reason: "closed" });
    expect(parseTakeOutcome({ ok: true })).toBeNull();
    expect(parseTakeOutcome(null)).toBeNull();
    expect(parseTakeOutcome("taken")).toBeNull();
  });

  it("says in plain Hebrew what happened", () => {
    expect(takeMessage({ ok: true, result: "taken" })).toContain("אצלכם");
    expect(takeMessage({ ok: true, result: "acknowledged" })).toContain("מטפלים");
    expect(takeMessage({ ok: false, reason: "taken", ownerName: "דנה" })).toBe("הליד כבר אצל דנה.");
    expect(takeMessage({ ok: false, reason: "taken", ownerName: null })).toBe("הליד כבר אצל מישהו אחר בצוות.");
    expect(takeMessage({ ok: false, reason: "closed" })).toContain("הומר");
  });

  it("the take route accepts only our own service worker's request", () => {
    const h = (values: Record<string, string>) => new Headers(values);
    expect(isOwnTakeRequest(h({ [TAKE_HEADER]: "1", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isOwnTakeRequest(h({ [TAKE_HEADER]: "1" }))).toBe(true);
    expect(isOwnTakeRequest(h({ "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isOwnTakeRequest(h({ [TAKE_HEADER]: "1", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isOwnTakeRequest(h({ [TAKE_HEADER]: "1", "sec-fetch-site": "same-site" }))).toBe(false);
  });
});

// public/sw.js run in a sandbox with a fake service worker scope
type Shown = { title: string; options: Record<string, unknown> };
function loadWorker(maxActions?: number, fetchAnswer?: () => Promise<unknown>) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const shown: Shown[] = [];
  const opened: string[] = [];
  const fetched: { url: string; init: Record<string, unknown> }[] = [];
  const self = {
    location: { origin: "https://crm.example" },
    addEventListener: (name: string, fn: (event: unknown) => void) => {
      listeners[name] = fn;
    },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () => Promise.resolve([]),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve(null);
      },
    },
  };
  const context: Record<string, unknown> = {
    self,
    URL,
    caches: { open: () => Promise.resolve({ addAll: () => Promise.resolve() }), keys: () => Promise.resolve([]), match: () => Promise.resolve(undefined) },
    fetch: (url: string, init: Record<string, unknown>) => {
      fetched.push({ url, init });
      return fetchAnswer ? fetchAnswer() : Promise.reject(new Error("offline"));
    },
  };
  if (maxActions !== undefined) context.Notification = { maxActions };
  runInNewContext(readFileSync("public/sw.js", "utf8"), context);

  const run = async (name: string, event: Record<string, unknown>) => {
    let wait: Promise<unknown> = Promise.resolve();
    listeners[name]({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  const push = (data: unknown) => run("push", { data: { json: () => data, text: () => JSON.stringify(data) } });
  const click = (shownIndex: number, action = "") =>
    run("notificationclick", { action, notification: { ...shown[shownIndex].options, close: () => undefined } });
  return { push, click, shown, opened, fetched };
}

describe("service worker buttons (SPD-01)", () => {
  const leadPayload = pushPayload(note({ lead_actions: true }));

  it("shows as many buttons as the browser allows, most important first", async () => {
    const two = loadWorker(2);
    await two.push(leadPayload);
    expect((two.shown[0].options.actions as { action: string }[]).map((a) => a.action)).toEqual(["take", "call"]);

    const three = loadWorker(3);
    await three.push(leadPayload);
    expect((three.shown[0].options.actions as unknown[]).length).toBe(3);

    // no buttons at all (iPhone): a tap opens the screen with all three
    const none = loadWorker(0);
    await none.push(leadPayload);
    expect(none.shown[0].options.actions).toBeUndefined();
    await none.click(0);
    expect(none.opened).toEqual([`https://crm.example/o/${ORG}/leads/${LEAD}/respond`]);
  });

  it("an old payload without buttons works as before", async () => {
    const worker = loadWorker(2);
    await worker.push({ title: "משימה", body: "עסק", url: `/o/${ORG}/tasks`, tag: "t" });
    expect(worker.shown[0].options.actions).toBeUndefined();
    await worker.click(0);
    expect(worker.opened).toEqual([`https://crm.example/o/${ORG}/tasks`]);
  });

  it("never follows a link to another site", async () => {
    const worker = loadWorker(3);
    await worker.push({ ...leadPayload, url: "//evil.example/x", links: { take: "https://evil.example/t", call: "//evil.example", whatsapp: `/o/${ORG}/x` } });
    expect((worker.shown[0].options.actions as { action: string }[]).map((a) => a.action)).toEqual(["whatsapp"]);
    expect((worker.shown[0].options.data as { url: string }).url).toBe("/");

    // a backslash after the slash is read as "//" by the URL parser
    const slashed = loadWorker(3);
    await slashed.push({ ...leadPayload, url: "/\\evil.example/x", links: { take: "/\\evil.example/t", call: "/\\evil.example", whatsapp: "/\\evil.example" } });
    expect(slashed.shown[0].options.actions).toBeUndefined();
    expect((slashed.shown[0].options.data as { url: string }).url).toBe("/");
    expect(new URL("/\\evil.example/x", "https://crm.example").origin).toBe("https://evil.example");
  });

  it("call and WhatsApp open the screen that starts them", async () => {
    const worker = loadWorker(3);
    await worker.push(leadPayload);
    await worker.click(0, "call");
    await worker.click(0, "whatsapp");
    expect(worker.opened).toEqual([
      `https://crm.example/o/${ORG}/leads/${LEAD}/respond?do=call`,
      `https://crm.example/o/${ORG}/leads/${LEAD}/respond?do=whatsapp`,
    ]);
  });

  it("'לקחתי' posts with the user's cookies and shows the answer", async () => {
    const worker = loadWorker(2, () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, message: "הליד אצלכם." }) }));
    await worker.push(leadPayload);
    await worker.click(0, "take");
    expect(worker.fetched).toHaveLength(1);
    expect(worker.fetched[0].url).toBe(`/o/${ORG}/leads/${LEAD}/take`);
    expect(worker.fetched[0].init).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "manual", headers: { [TAKE_HEADER]: "1" } });
    expect(worker.shown[1]).toMatchObject({ title: "הליד אצלכם", options: { body: "הליד אצלכם." } });
    expect(worker.opened).toEqual([]);
  });

  it("when 'לקחתי' cannot be done from the push, the screen opens", async () => {
    // signed out: the app redirects to the login page
    const worker = loadWorker(2, () => Promise.resolve({ ok: false, status: 0, type: "opaqueredirect" }));
    await worker.push(leadPayload);
    await worker.click(0, "take");
    expect(worker.opened).toEqual([`https://crm.example/o/${ORG}/leads/${LEAD}/respond`]);
  });
});

describe("who still sees a taken lead on the waiting screen (SPD-01)", () => {
  const ME = "55555555-5555-4555-8555-555555555555";
  const TEAM = "66666666-6666-4666-8666-666666666666";
  const SUB = "77777777-7777-4777-8777-777777777777";

  it("owners and admins see every lead", () => {
    expect(takenLeadsFilter({ id: ME, role: "owner" })).toBeNull();
    expect(takenLeadsFilter({ id: ME, role: "admin" })).toBeNull();
  });

  it("everyone else sees untaken leads and their own", () => {
    expect(takenLeadsFilter({ id: ME, role: "member" })).toBe(`taken_at.is.null,owner_id.eq.${ME}`);
    expect(takenLeadsFilter({ id: ME, role: "viewer", overseenTeamIds: [TEAM] })).toBe(`taken_at.is.null,owner_id.eq.${ME}`);
    // a manager of no team is like a member
    expect(takenLeadsFilter({ id: ME, role: "manager", overseenTeamIds: [] })).toBe(`taken_at.is.null,owner_id.eq.${ME}`);
  });

  it("a team manager also sees the leads of the teams they oversee (ids only)", () => {
    expect(takenLeadsFilter({ id: ME, role: "manager", overseenTeamIds: [TEAM, SUB, "x),owner_id.is.null"] })).toBe(
      `taken_at.is.null,owner_id.eq.${ME},team_id.in.(${TEAM},${SUB})`,
    );
  });

  it("the teams under a managed team are overseen too, as in app.manages_team()", () => {
    const OTHER = "88888888-8888-4888-8888-888888888888";
    const chain = [
      { id: TEAM, parentTeamId: null },
      { id: SUB, parentTeamId: TEAM },
      { id: OTHER, parentTeamId: null },
    ];
    const overseen = chain.filter((t) => managesTeamChain(t.id, chain, new Set([TEAM]))).map((t) => t.id);
    expect(overseen).toEqual([TEAM, SUB]);
  });

  it("marks a taken lead with who took it", () => {
    const at = "2026-10-13T08:00:00Z";
    expect(takenLabel({ takenAt: null, ownerId: ME, ownerName: "דנה" }, ME)).toBeNull();
    expect(takenLabel({ takenAt: at, ownerId: ME, ownerName: "דנה" }, ME)).toBe("לקחתם את הליד");
    expect(takenLabel({ takenAt: at, ownerId: TEAM, ownerName: "דנה" }, ME)).toBe("נלקח על ידי דנה");
    expect(takenLabel({ takenAt: at, ownerId: TEAM, ownerName: null }, ME)).toBe("נלקח על ידי מישהו אחר בצוות");
  });
});
