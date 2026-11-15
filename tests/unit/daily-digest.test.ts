import { describe, expect, it } from "vitest";

import { buildDigestEmail, digestCountsFrom, digestDayLabel, topMoneyLines, type DigestCounts, type DigestEmailInput } from "@/features/digest/email";
import { createDigestHandler, parseDigestComposed } from "@/features/digest/send-handler";
import type { OutgoingMessage } from "@/features/messaging/providers/types";
import { DIGEST_TIME_INVALID, DIGEST_TIMES, digestKindFor, digestSettingsFromRow, parseDigestForm } from "@/features/digest/settings";

import { latestMigrationText } from "./helpers/migrations";

// USR-11 second part / WAB-03 / MNY-03: the daily summary's setting and its email text.

describe("the setting mirrors the database", () => {
  const sql = latestMigrationText("create table if not exists public.digest_settings") ?? "";

  it("the times are the quarter hours the constraint accepts, 05:00 to 12:00", () => {
    expect(sql).toContain("send_at >= '05:00'::time and send_at <= '12:00'::time");
    expect(sql).toContain("% 15 = 0");
    expect(DIGEST_TIMES[0]).toBe("05:00");
    expect(DIGEST_TIMES.at(-1)).toBe("12:00");
    expect(DIGEST_TIMES).toHaveLength(29);
    expect(DIGEST_TIMES).toContain("07:30");
  });

  it("the default is off at 07:30, as the table's", () => {
    expect(sql).toContain("enabled         boolean not null default false");
    expect(sql).toContain("send_at         time not null default '07:30'");
    expect(digestSettingsFromRow(null)).toEqual({ enabled: false, sendAt: "07:30" });
    expect(digestSettingsFromRow({ enabled: true, send_at: "08:45:00" })).toEqual({ enabled: true, sendAt: "08:45" });
  });

  it("the kind of summary is app.digest_kind_for's", () => {
    expect(sql).toContain("when p_role in ('owner', 'admin', 'manager') then 'manager' else 'personal'");
    expect(["owner", "admin", "manager"].map(digestKindFor)).toEqual(["manager", "manager", "manager"]);
    expect(["member", "viewer", null].map(digestKindFor)).toEqual(["personal", "personal", "personal"]);
  });
});

describe("the form", () => {
  it("takes a time from the list only", () => {
    expect(parseDigestForm("on", "07:30")).toEqual({ ok: true, settings: { enabled: true, sendAt: "07:30" } });
    expect(parseDigestForm(null, "12:00")).toEqual({ ok: true, settings: { enabled: false, sendAt: "12:00" } });
    for (const bad of ["04:45", "07:10", "", "7:30", "12:15"]) {
      expect(parseDigestForm("on", bad)).toEqual({ ok: false, message: DIGEST_TIME_INVALID });
    }
  });
});

describe("the email", () => {
  const counts: DigestCounts = {
    newLeads: 4,
    waitingLeads: 2,
    overdueTasks: 3,
    tasksToday: 5,
    moneyWaiting: {
      totalAgorot: 1_234_500,
      lines: [
        { label: "עסקאות תקועות", agorot: 500_000 },
        { label: "הצעות מחיר פתוחות", agorot: 600_000 },
        { label: "חובות", agorot: 134_500 },
        { label: "חידושים", agorot: 0 },
      ],
    },
  };
  const base: DigestEmailInput = {
    kind: "manager",
    businessName: "סטודיו‮ דנה\n",
    dayLabel: "יום שני, 16 בנובמבר",
    counts,
    links: {
      myDay: "https://mexuzsystem.com/o/x",
      leadsWaiting: "https://mexuzsystem.com/o/x/leads/waiting",
      tasks: "https://mexuzsystem.com/o/x/tasks",
      moneyWaiting: "https://mexuzsystem.com/o/x/reports/money",
      settings: "https://mexuzsystem.com/o/x/settings/account#account-notifications",
      stop: "https://mexuzsystem.com/f/digest-stop/" + "a".repeat(64),
    },
  };

  it("a manager's summary holds the business lines and the money waiting with its three largest groups", () => {
    const email = buildDigestEmail(base);
    // owner (378) א: the approved subject
    expect(email.subject).toBe("הסיכום היומי שלכם בסטודיו דנה: יום שני, 16 בנובמבר");
    expect(email.text).toContain("לידים חדשים מאתמול: 4");
    expect(email.text).toContain("לידים שמחכים למגע ראשון: 2");
    expect(email.text).toContain("משימות באיחור בצוות: 3");
    expect(email.text).toContain('כסף שמחכה (כולל מע"מ)');
    const money = email.text.split("\n").filter((l) => l.startsWith("· "));
    expect(money.map((l) => l.split(":")[0])).toEqual(["· הצעות מחיר פתוחות", "· עסקאות תקועות", "· חובות"]);
    expect(email.links).toContain(base.links.moneyWaiting);
    // owner (377) ב: the footer carries the one-click stop link and the settings
    expect(email.text).toContain(`להפסקת הסיכום בלחיצה אחת: ${base.links.stop}`);
    expect(email.text).toContain(`לשינוי השעה או להפעלה מחדש: ${base.links.settings}`);
    expect(email.links).toEqual(expect.arrayContaining([base.links.stop, base.links.settings]));
  });

  it("a personal summary has no business lines, and no money without a number", () => {
    const email = buildDigestEmail({ ...base, kind: "personal", counts: { ...counts, moneyWaiting: null } });
    expect(email.text).not.toContain("לידים חדשים מאתמול");
    expect(email.text).not.toContain("בצוות");
    expect(email.text).toContain("לידים שלכם שמחכים למגע ראשון: 2");
    expect(email.text).not.toContain("כסף שמחכה");
    expect(email.links).not.toContain(base.links.moneyWaiting);
  });

  it("owner (375) ב: a person who reads nothing gets fixed text and a link only", () => {
    const email = buildDigestEmail({ ...base, counts: null });
    expect(email.text).not.toMatch(/\d+\s*$/m);
    expect(email.text).toContain(`היום שלי: ${base.links.myDay}`);
    expect(email.text).toContain(base.links.stop);
    expect(email.links).not.toContain(base.links.leadsWaiting);
  });

  it("with the leads module off there is no lead line", () => {
    const email = buildDigestEmail({ ...base, counts: { ...counts, newLeads: null, waitingLeads: null } });
    expect(email.text).not.toContain("לידים");
  });

  it("the business name is one clean line", () => {
    const email = buildDigestEmail({ ...base, businessName: "\u0007\n " });
    expect(email.subject).toContain("בהעסק");
    // no control or direction characters anywhere
    expect(/[\u0000-\u0009\u000b-\u001f‪-‮]/.test(buildDigestEmail(base).text + buildDigestEmail(base).subject)).toBe(false);
  });

  it("negative or broken counts never show", () => {
    const email = buildDigestEmail({ ...base, counts: { ...counts, newLeads: -3, tasksToday: 2.7 } });
    expect(email.text).toContain("לידים חדשים מאתמול: 0");
    expect(email.text).toContain("משימות שלכם להיום: 2");
    expect(topMoneyLines([{ label: "x", agorot: Number.NaN }, { label: "y", agorot: -5 }])).toEqual([]);
  });

  it("the day as the email names it", () => {
    expect(digestDayLabel("2026-11-16")).toBe("יום שני, 16 בנובמבר");
    expect(digestDayLabel("2026-02-30")).toBeNull();
    expect(digestDayLabel("16/11/2026")).toBeNull();
  });
});

describe("the composer's answer", () => {
  it("counts: the database's shape only; reads nothing = null; money groups by MNY-01's titles, the total of all groups", () => {
    expect(digestCountsFrom(null)).toBeNull();
    expect(digestCountsFrom({ reads_anything: false })).toBeNull();
    expect(digestCountsFrom({ reads_anything: true, overdue_tasks: "3", tasks_today: 1 })).toBeNull();
    const c = digestCountsFrom({
      reads_anything: true,
      new_leads: 1,
      waiting_leads: null,
      overdue_tasks: 2,
      tasks_today: 3,
      money: { vat_mode: "unknown", groups: { debts: null, quotes: 100, stuck: 200, overdue: 0, renewals: 50 } },
    });
    expect(c).toMatchObject({ newLeads: 1, waitingLeads: null, overdueTasks: 2, tasksToday: 3 });
    expect(c?.moneyWaiting?.totalAgorot).toBe(350);
    expect(c?.moneyWaiting?.vat).toBe("unknown");
    expect(c?.moneyWaiting?.lines.map((l) => l.label)).toEqual(["הצעות מחיר שנשלחו ולא נענו", "עסקאות תקועות", "עסקאות שתאריך הסגירה שלהן עבר", "חידושים בחודש הקרוב"]);
  });

  it("parses only the composer's own shapes", () => {
    const token = "b".repeat(64);
    expect(parseDigestComposed({ refused: "switched_off" })).toEqual({ ok: false, code: "switched_off" });
    expect(parseDigestComposed({ refused: "Bad Code!" })).toBeNull();
    expect(parseDigestComposed({ to: "a@b.co", business_name: "x", day: "2026-11-16", kind: "manager", counts: null, stop_token: "short" })).toBeNull();
    expect(parseDigestComposed({ to: "a@b.co", business_name: "x", day: "2026-11-16", kind: "manager", counts: null, stop_token: token })).toMatchObject({ ok: true, stopToken: token });
  });
});

describe("the digest.send handler", () => {
  const job = { id: "11111111-2222-4333-8444-555555555555", lease: "l", kind: "digest.send" as const, organization_id: "66666666-7777-4888-8999-aaaaaaaaaaaa", payload: { user_id: "u" }, attempt: 1 };
  const answer = { to: "rep@example.com", business_name: "עסק", day: "2026-11-16", kind: "personal", counts: { reads_anything: true, waiting_leads: 1, overdue_tasks: 0, tasks_today: 2 }, stop_token: "c".repeat(64) };

  it("sends one email with the stop link as RFC 8058 List-Unsubscribe, and ends a refusal without sending", async () => {
    const sent: OutgoingMessage[] = [];
    const provider = { name: "fake", channel: "email" as const, send: async (m: OutgoingMessage) => (sent.push(m), { ok: true as const, providerId: "p1" }) };
    const ok = await createDigestHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => answer })(job);
    expect(ok).toEqual({ status: "done", receipt: { provider: "fake", providerMessageId: "p1" } });
    expect(sent).toHaveLength(1);
    const mail = sent[0].emailContent!;
    expect(mail.to).toBe("rep@example.com");
    expect(mail.subject).toBe("הסיכום היומי שלכם בעסק: יום שני, 16 בנובמבר");
    expect(mail.listUnsubscribe).toBe(`https://mexuzsystem.com/api/forms/digest-stop/${"c".repeat(64)}`);
    expect(mail.text).toContain(`https://mexuzsystem.com/f/digest-stop/${"c".repeat(64)}`);
    expect(mail.attachments).toEqual([]);
    const refused = await createDigestHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => ({ refused: "feature_off" }) })(job);
    expect(refused).toMatchObject({ status: "failed", final: true, receipt: { provider: null, errorCode: "feature_off" } });
    const stale = await createDigestHandler({ provider, siteOrigin: () => "https://mexuzsystem.com", compose: async () => ({ refused: "stale" }) })(job);
    expect(stale).toEqual({ status: "failed", error: "stale lease" });
    // no site address: nothing is composed or sent, tried again later
    let asked = false;
    const noSite = await createDigestHandler({ provider, siteOrigin: () => "", compose: async () => ((asked = true), answer) })(job);
    expect(noSite).toMatchObject({ status: "failed" });
    expect(asked).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
